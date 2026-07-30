const Subscription = require('../models/Subscription');
const VendorHoliday = require('../models/VendorHoliday');
const DeliverySession = require('../models/DeliverySession');

const normalizeDateKey = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  const dateKey = raw.includes('T') ? raw.slice(0, 10) : raw;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : null;
};

const getDeliverySessionsByPlan = (planType) => {
  const plan = String(planType || '').toLowerCase();
  if (plan.includes('full')) return ['morning', 'afternoon'];
  if (plan.includes('half')) return ['afternoon'];
  if (plan.includes('single')) return ['afternoon'];
  return ['afternoon'];
};

/**
 * Calculate deliveries for a vendor on a given date and session.
 * Returns { totalCount, locationWise }
 */
exports.calculateDeliveriesForSession = async (vendorId, dateKey, sessionName) => {
  const targetDateKey = normalizeDateKey(dateKey) || new Date().toISOString().split('T')[0];

  // If vendor marked holiday, no deliveries
  const holiday = await VendorHoliday.findOne({ vendor: vendorId, dateKey: targetDateKey });
  if (holiday) return { totalCount: 0, locationWise: {} };

  const activeSubs = await Subscription.find({ vendor: vendorId, status: 'active' })
    .populate('customer', 'name phone location roomNumber');

  const locationWise = {};
  let total = 0;

  activeSubs.forEach((sub) => {
    try {
      if (!sub.customer) return;

      const allowed = getDeliverySessionsByPlan(sub.planType || '');
      if (!allowed.includes(sessionName)) return;

      const skipped = Array.isArray(sub.skippedDates) && sub.skippedDates.some(d => d.date === targetDateKey && (d.time === sessionName || d.time === 'full_day'));
      if (skipped) return;

      const loc = sub.customer.location || 'Unknown';
      if (!locationWise[loc]) locationWise[loc] = [];

      locationWise[loc].push({
        subscriptionId: sub._id,
        customerName: sub.customer.name,
        roomNumber: sub.customer.roomNumber || '',
        phone: sub.customer.phone || '',
        mealType: sub.mealType || sub.planType || ''
      });

      total += 1;
    } catch (e) {
      // ignore per-subscription errors to keep scheduler robust
      console.error('Scheduler: error processing subscription', e);
    }
  });

  return { totalCount: total, locationWise };
};

/**
 * Update (or create) the DeliverySession document for the vendor and session for today (or provided dateKey).
 * Returns the updated DeliverySession document.
 */
exports.updateDeliveriesForSession = async (vendorId, sessionName, dateKey) => {
  const targetDateKey = normalizeDateKey(dateKey) || new Date().toISOString().split('T')[0];

  const data = await exports.calculateDeliveriesForSession(vendorId, targetDateKey, sessionName);

  const update = {
    currentSession: sessionName,
    lastUpdated: new Date()
  };

  update[`${sessionName}Deliveries.totalCount`] = data.totalCount || 0;
  update[`${sessionName}Deliveries.locationWise`] = data.locationWise || {};

  const opts = { new: true, upsert: true, setDefaultsOnInsert: true };
  const sessionDoc = await DeliverySession.findOneAndUpdate(
    { vendor: vendorId, date: targetDateKey },
    { $set: update },
    opts
  );

  return sessionDoc;
};
