'use strict';

/**
 * billingCron.js — Daily Billing & Payment Notification Engine
 * ─────────────────────────────────────────────────────────────
 * Runs once per day at 09:00 AM IST.
 *
 * Three independent jobs inside one schedule tick:
 *
 *  Job 1 — Pre-Expiry Countdown (Student)
 *    Notifies students whose plan ends in exactly 1, 2, or 3 days.
 *    The message is personalised per kitchen name and days remaining.
 *
 *  Job 2 — Overdue Dues Reminder (Student, daily)
 *    Notifies every student who has an outstanding balance after their
 *    plan has already ended. Uses `lastReminderSentAt` to ensure we send
 *    at most ONE reminder per student per calendar day.
 *
 *  Job 3 — Vendor Collection Alert (Vendor, one-time)
 *    The day AFTER a plan ends, the vendor receives a single push if the
 *    student still has an unpaid balance. Fires only once (endDate === yesterday)
 *    to avoid spamming the vendor every day.
 */

const cron          = require('node-cron');
const Subscription  = require('../models/Subscription');
const VendorProfile = require('../models/VendorProfile');
const User          = require('../models/User');
const { sendPushNotification } = require('../controllers/notificationController');
const { IST_TIME_ZONE }        = require('../utils/dailyMenuDateKey');

// ─────────────────────────────────────────────────────────────────────────────
// IST-aware date helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a UTC Date object representing MIDNIGHT (00:00:00 IST) on the
 * IST calendar date that is `offsetDays` from today.
 *
 * Examples (run at any UTC time on 2026-08-11):
 *   istMidnight(0)  → 2026-08-10T18:30:00.000Z  (midnight IST 2026-08-11)
 *   istMidnight(1)  → 2026-08-11T18:30:00.000Z  (midnight IST 2026-08-12)
 *   istMidnight(-1) → 2026-08-09T18:30:00.000Z  (midnight IST 2026-08-10)
 */
const istMidnight = (offsetDays = 0) => {
  // Get today's IST date string ("YYYY-MM-DD")
  const istDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Parse that as an IST midnight → exact UTC equivalent
  const base = new Date(`${istDateStr}T00:00:00.000+05:30`);

  // Shift by whole days (each day = 86 400 000 ms)
  return new Date(base.getTime() + offsetDays * 86_400_000);
};

// ─────────────────────────────────────────────────────────────────────────────
// Job 1 — Pre-Expiry Countdown Notifications (Student)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For each of [3, 2, 1] days-before-expiry, queries subscriptions whose
 * endDate falls within that IST calendar day and sends the relevant student
 * a countdown push notification.
 *
 * Query uses $gte / $lt against UTC day boundaries — no full-collection scan.
 */
const runPreExpiryNotifications = async (runLabel) => {
  const NOTICE_DAYS = [3, 2, 1];

  for (const daysLeft of NOTICE_DAYS) {
    const dayStart = istMidnight(daysLeft);      // midnight of the target IST day
    const dayEnd   = istMidnight(daysLeft + 1);  // midnight of the following IST day

    let subs;
    try {
      subs = await Subscription
        .find({
          status:  'active',
          endDate: { $gte: dayStart, $lt: dayEnd },
        })
        .select('customer vendor endDate')
        .populate('customer', 'name fcmToken')
        .populate('vendor',   'businessName')
        .lean();
    } catch (dbErr) {
      console.error(`${runLabel} [PreExpiry-${daysLeft}d] DB query failed:`, dbErr.message);
      continue;
    }

    if (!subs.length) {
      console.log(`${runLabel} [PreExpiry-${daysLeft}d] No subscriptions expiring in ${daysLeft} day(s).`);
      continue;
    }

    console.log(`${runLabel} [PreExpiry-${daysLeft}d] Notifying ${subs.length} student(s).`);

    await Promise.all(subs.map(async (sub) => {
      const token   = sub.customer?.fcmToken;
      const student = sub.customer?.name        || 'Student';
      const kitchen = sub.vendor?.businessName  || 'your kitchen';

      if (!token) return; // no device token — safe skip

      const dayWord = daysLeft === 1 ? 'day' : 'days';

      // NOTE: The Subscription schema has no `autoRenew` field yet.
      // When auto-renewal is added to the schema, enable the branch below.
      // const autoRenew = sub.autoRenew === true;
      const autoRenew = false; // placeholder — update when schema field is added

      let title, body;
      if (autoRenew && daysLeft === 3) {
        title = '🔄 Plan Auto-Renewing Soon';
        body  = `Your ${kitchen} plan auto-renews in 3 days! Make sure your dues are clear.`;
      } else {
        title = `⏳ Plan Ending in ${daysLeft} ${dayWord}`;
        body  = `Your ${kitchen} tiffin plan ends in ${daysLeft} ${dayWord}. Clear any dues to avoid interruption!`;
      }

      try {
        await sendPushNotification(token, title, body);
        console.log(`${runLabel} [PreExpiry-${daysLeft}d] ✅ Notified ${student}`);
      } catch (fcmErr) {
        console.warn(`${runLabel} [PreExpiry-${daysLeft}d] ❌ FCM failed for ${student}:`, fcmErr?.message);
      }
    }));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Job 2 — Post-Expiry Overdue Dues Reminder (Student, daily)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queries ALL subscriptions where:
 *   • endDate is strictly before today (plan has ended)
 *   • paymentStatus is 'unpaid' or 'partial'
 *   • outstanding balance (totalBill - amountPaid) > 0
 *
 * Deduplication: if `lastReminderSentAt` already falls within today's IST
 * calendar window, the notification is skipped so the student only receives
 * one reminder per day regardless of how many plans they owe money on.
 *
 * On a successful send, updates `lastReminderSentAt` to now so the guard
 * holds for the rest of the calendar day.
 */
const runOverdueReminders = async (runLabel) => {
  const todayStart = istMidnight(0);  // today's IST midnight (UTC)
  const todayEnd   = istMidnight(1);  // tomorrow's IST midnight (UTC)

  let subs;
  try {
    subs = await Subscription
      .find({
        endDate:       { $lt: todayStart },
        paymentStatus: { $in: ['unpaid', 'partial'] },
      })
      .select('customer vendor totalBill amountPaid lastReminderSentAt')
      .populate('customer', 'name fcmToken')
      .populate('vendor',   'businessName')
      .lean();
  } catch (dbErr) {
    console.error(`${runLabel} [OverdueReminder] DB query failed:`, dbErr.message);
    return;
  }

  // Secondary in-process filter: only positive outstanding balance
  const overdue = subs.filter(s => (s.totalBill - (s.amountPaid || 0)) > 0);

  if (!overdue.length) {
    console.log(`${runLabel} [OverdueReminder] No overdue subscriptions found.`);
    return;
  }

  console.log(`${runLabel} [OverdueReminder] Processing ${overdue.length} overdue subscription(s).`);

  await Promise.all(overdue.map(async (sub) => {
    const token       = sub.customer?.fcmToken;
    const student     = sub.customer?.name || 'Student';
    const outstanding = Math.round(sub.totalBill - (sub.amountPaid || 0));

    if (!token) return;

    // Suppress if we already reminded this student today
    if (sub.lastReminderSentAt) {
      const last = new Date(sub.lastReminderSentAt);
      if (last >= todayStart && last < todayEnd) {
        console.log(`${runLabel} [OverdueReminder] Skipping ${student} — already notified today.`);
        return;
      }
    }

    const title = '💳 Action Required: Kitchen Dues Pending';
    const body  = `You have pending kitchen dues of ₹${outstanding}. Please pay to clear your Digital Khata.`;

    try {
      await sendPushNotification(token, title, body);

      // Stamp the reminder time so we don't double-notify today
      await Subscription.findByIdAndUpdate(sub._id, { lastReminderSentAt: new Date() });

      console.log(`${runLabel} [OverdueReminder] ✅ Reminded ${student} — ₹${outstanding} outstanding.`);
    } catch (fcmErr) {
      console.warn(`${runLabel} [OverdueReminder] ❌ FCM failed for ${student}:`, fcmErr?.message);
    }
  }));
};

// ─────────────────────────────────────────────────────────────────────────────
// Job 3 — Vendor Collection Alert (One-time, day after plan expiry)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queries subscriptions whose endDate fell exactly YESTERDAY (IST).
 * For each with an outstanding balance, notifies the vendor once so they
 * know to collect payment from the student.
 *
 * Querying only the "yesterday" window is the natural deduplication mechanism:
 * this window never recurs, guaranteeing exactly one alert per student plan.
 *
 * Vendor FCM token lookup chain:
 *   Subscription.vendor (VendorProfile._id)
 *     → VendorProfile.vendorId (User._id)
 *       → User.fcmToken
 */
const runVendorCollectionAlerts = async (runLabel) => {
  const yesterdayStart = istMidnight(-1);  // midnight of yesterday IST (UTC)
  const todayStart     = istMidnight(0);   // midnight of today IST (UTC)

  let subs;
  try {
    subs = await Subscription
      .find({
        endDate: { $gte: yesterdayStart, $lt: todayStart },
      })
      .select('customer vendor totalBill amountPaid')
      .populate('customer', 'name')
      .populate('vendor',   'vendorId businessName')
      .lean();
  } catch (dbErr) {
    console.error(`${runLabel} [VendorAlert] DB query failed:`, dbErr.message);
    return;
  }

  // Keep only subscriptions with a positive outstanding balance
  const pending = subs.filter(s => (s.totalBill - (s.amountPaid || 0)) > 0);

  if (!pending.length) {
    console.log(`${runLabel} [VendorAlert] No plans expired yesterday with outstanding dues.`);
    return;
  }

  console.log(`${runLabel} [VendorAlert] ${pending.length} plan(s) expired yesterday with dues.`);

  await Promise.all(pending.map(async (sub) => {
    const student     = sub.customer?.name || 'A student';
    const outstanding = Math.round(sub.totalBill - (sub.amountPaid || 0));
    const vendorOId   = sub.vendor?.vendorId; // ObjectId → User

    if (!vendorOId) {
      console.warn(`${runLabel} [VendorAlert] No vendorId on VendorProfile for sub ${sub._id} — skipping.`);
      return;
    }

    let vendorUser;
    try {
      vendorUser = await User.findById(vendorOId).select('fcmToken name').lean();
    } catch (lookupErr) {
      console.warn(`${runLabel} [VendorAlert] User lookup failed for vendorId ${vendorOId}:`, lookupErr.message);
      return;
    }

    const token  = vendorUser?.fcmToken;
    const vendor = vendorUser?.name || 'Vendor';

    if (!token) {
      console.log(`${runLabel} [VendorAlert] ${vendor} has no FCM token — skipping.`);
      return;
    }

    const title = '💰 Plan Ended — Collect Dues';
    const body  = `${student}'s plan ended yesterday. Collect their pending due of ₹${outstanding}.`;

    try {
      await sendPushNotification(token, title, body);
      console.log(`${runLabel} [VendorAlert] ✅ Alerted ${vendor} about ${student} — ₹${outstanding}.`);
    } catch (fcmErr) {
      console.warn(`${runLabel} [VendorAlert] ❌ FCM failed for vendor ${vendor}:`, fcmErr?.message);
    }
  }));
};

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — runs all three jobs sequentially under one run label
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point. Runs all three billing notification jobs in sequence.
 * Each job is independently try-caught so a failure in one never blocks the others.
 * Exported so it can be triggered manually via an admin/debug route without
 * waiting for the next scheduled tick.
 */
const runBillingCron = async () => {
  const istNow = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());

  const runLabel = `[BillingCron:${istNow}]`;
  console.log(`${runLabel} ════ Starting billing cron run ════`);

  try { await runPreExpiryNotifications(runLabel); }
  catch (err) { console.error(`${runLabel} [PreExpiry] Uncaught:`, err); }

  try { await runOverdueReminders(runLabel); }
  catch (err) { console.error(`${runLabel} [OverdueReminder] Uncaught:`, err); }

  try { await runVendorCollectionAlerts(runLabel); }
  catch (err) { console.error(`${runLabel} [VendorAlert] Uncaught:`, err); }

  console.log(`${runLabel} ════ Billing cron run complete ════`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers the billing cron at 09:00 AM IST every day.
 * Must be called AFTER the MongoDB connection resolves in server.js.
 */
const registerBillingCron = () => {
  cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] 09:00 IST — running billing notification jobs...');
    await runBillingCron();
  }, {
    timezone: IST_TIME_ZONE,
  });

  console.log('✅ Billing cron registered (payment reminders at 09:00 IST).');
};

module.exports = {
  registerBillingCron,
  runBillingCron, // manual trigger from admin endpoint
};
