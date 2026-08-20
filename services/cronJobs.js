'use strict';

const cron = require('node-cron');
const VendorHoliday = require('../models/VendorHoliday');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { sendPushNotification } = require('../controllers/notificationController');
const { normalizeDateKey } = require('../utils/dailyMenuDateKey');
const { registerBillingCron, runBillingCron } = require('./billingCron');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a VendorHoliday `time` field to a human-readable meal label.
 * Mirrors the Flutter _mapTime() function in student_home_screen.dart.
 */
const mapTime = (raw) => {
  switch ((raw || '').toLowerCase()) {
    case 'morning':   return 'Lunch';
    case 'afternoon': return 'Dinner';
    case 'full_day':  return 'the Entire Day';
    default:          return 'the Day';
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Core job: send "Kitchen Closed Today" push notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds all vendor holidays for TODAY (IST), then notifies every active
 * subscriber of each affected kitchen via FCM.
 *
 * Notification cadence:
 *   • One notification per student per holiday record (a vendor can post
 *     separate morning / afternoon / full_day holidays on the same day, so a
 *     student on a "Both Meals" plan might get two short notifications instead
 *     of one vague combined message — this matches user expectations).
 *
 * Error strategy:
 *   • Per-notification errors are caught individually so one bad FCM token
 *     never aborts delivery to the remaining students.
 */
const sendTodayHolidayNotifications = async () => {
  const todaysDateKey = normalizeDateKey();           // IST "YYYY-MM-DD"
  const runLabel = `[HolidayCron:${todaysDateKey}]`;

  console.log(`${runLabel} Starting run...`);

  try {
    // 1. Find every holiday record for today, populate vendor business name.
    const holidays = await VendorHoliday.find({ dateKey: todaysDateKey })
      .populate('vendor', 'businessName')
      .lean();

    if (!holidays.length) {
      console.log(`${runLabel} No vendor holidays found — nothing to notify.`);
      return;
    }

    console.log(`${runLabel} Found ${holidays.length} holiday record(s). Processing...`);

    for (const holiday of holidays) {
      const vendorId       = holiday.vendor?._id;
      const businessName   = holiday.vendor?.businessName || 'Your Kitchen';
      const mappedTime     = mapTime(holiday.time);

      if (!vendorId) {
        console.warn(`${runLabel} Holiday ${holiday._id} has no populated vendor — skipping.`);
        continue;
      }

      // 2. All active subscribers of this vendor.
      const activeSubs = await Subscription.find({
        vendor: vendorId,
        status: 'active',
      })
        .select('customer')
        .populate('customer', 'fcmToken name')
        .lean();

      if (!activeSubs.length) {
        console.log(`${runLabel} ${businessName}: no active subscribers — skipping.`);
        continue;
      }

      console.log(
        `${runLabel} ${businessName} (${holiday.time}): notifying ${activeSubs.length} subscriber(s).`
      );

      const title = 'Kitchen Closed Today';
      const body  = `${businessName} is closed today for ${mappedTime}.`;

      // 3. Fire notifications concurrently per vendor, but catch individually.
      await Promise.all(
        activeSubs.map(async (sub) => {
          const fcmToken = sub.customer?.fcmToken;
          if (!fcmToken) return; // student has no device registered — safe skip

          try {
            await sendPushNotification(fcmToken, title, body, 'kitchen_holiday');
          } catch (notifyErr) {
            // Log the bad token but continue with others.
            console.warn(
              `${runLabel} Failed to notify customer ${sub.customer?._id}:`,
              notifyErr?.message ?? notifyErr
            );
          }
        })
      );
    }

    console.log(`${runLabel} Run complete.`);
  } catch (err) {
    // Top-level guard: never let the cron crash the process.
    console.error(`${runLabel} Unexpected error:`, err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule registration — called once at server startup from server.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers all application cron jobs.
 *
 * Timezone is set to 'Asia/Kolkata' (IST) so that "0 8 * * *" means
 * 8:00 AM IST regardless of the host machine's system clock.
 *
 * Call this function AFTER the MongoDB connection resolves so that every
 * job can safely perform DB queries on its first tick.
 */
const registerCronJobs = () => {
  // 8:00 AM IST — kitchen holiday notifications
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] 08:00 IST — running sendTodayHolidayNotifications...');
    await sendTodayHolidayNotifications();
  }, {
    timezone: 'Asia/Kolkata',
  });

  // 9:00 AM IST — billing reminders (pre-expiry, overdue dues, vendor collection)
  registerBillingCron();

  console.log('Cron jobs registered (holiday notifications: 08:00 IST | billing reminders: 09:00 IST).');
};

module.exports = {
  registerCronJobs,
  // Export raw functions so they can be triggered manually from a
  // debug/admin endpoint without waiting for the next scheduled tick.
  sendTodayHolidayNotifications,
  runBillingCron,
};
