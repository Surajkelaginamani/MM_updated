const VendorProfile = require('../models/VendorProfile');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Announcement = require('../models/Announcement');
const Review = require('../models/Review');
const HomemadeItem = require('../models/HomemadeItem');
const HomemadeOrder = require('../models/HomemadeOrder');
const HomemadeStockLog = require('../models/HomemadeStockLog');
const VendorHoliday = require('../models/VendorHoliday');
const DeliveryStatus = require('../models/DeliveryStatus');
const DailyMenu = require('../models/DailyMenu');
const { normalizeDateKey, getTodayMenuDateInfo, buildTodayMenuQuery, IST_TIME_ZONE } = require('../utils/dailyMenuDateKey');
const Transaction = require('../models/Transaction');
const TrialOrder = require('../models/TrialOrder');
const { sendPushNotification } = require('./notificationController');
const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const mapLikeToObject = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return value;
};

const normalizeLocationStudents = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (value instanceof Map) return normalizeLocationStudents(Array.from(value.values()));
  if (typeof value !== 'object') return [];
  if (value.customerName || value.subscriptionId) return [value];
  if (Array.isArray(value.students)) return value.students;

  return Object.values(value).flatMap((entry) => normalizeLocationStudents(entry));
};

const normalizeGroupedList = (groupedList) => {
  const source = mapLikeToObject(groupedList);
  if (!source || typeof source !== 'object') return {};

  return Object.fromEntries(
    Object.entries(source).map(([locationName, students]) => [
      locationName,
      normalizeLocationStudents(students)
    ])
  );
};

const countGroupedStudents = (groupedList) =>
  Object.values(normalizeGroupedList(groupedList)).reduce((sum, students) => sum + students.length, 0);

const getDeliverySessionsByPlan = (planType) => {
  const plan = String(planType || '').toLowerCase();
  if (plan.includes('full')) return ['morning', 'afternoon'];
  if (plan.includes('half')) return ['afternoon'];
  if (plan.includes('single')) return ['afternoon'];
  return ['afternoon'];
};

const getPlanDurationDays = (planType) => {
  const type = String(planType || '').toLowerCase();
  if (type.includes('single')) return 1;
  if (type.includes('weekly') || type.includes('7_days')) return 7;
  if (type.includes('15_days')) return 15;
  return 30;
};

const getPlanSessionCount = (planType) => {
  const type = String(planType || '').toLowerCase();
  if (type.includes('full')) return 2;
  return 1;
};

const getTotalTiffins = (planType) => getPlanDurationDays(planType) * getPlanSessionCount(planType);

const parseDateKeyAsLocal = (dateKey) => {
  if (!dateKey) return null;
  const parts = String(dateKey).split('-').map(Number);
  if (parts.length !== 3) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
};

const countSkippedTiffins = (skippedDates = [], until = new Date()) => {
  if (!Array.isArray(skippedDates)) return 0;
  const cutoff = new Date(until.getFullYear(), until.getMonth(), until.getDate(), 23, 59, 59);
  return skippedDates.reduce((count, entry) => {
    if (!entry) return count;
    const dateString = entry.date || entry;
    const time = entry.time || 'full_day';
    const targetDate = parseDateKeyAsLocal(String(dateString));
    if (!targetDate || targetDate.getTime() > cutoff.getTime()) return count;
    if (time === 'full_day') return count + 2;
    if (time === 'morning' || time === 'afternoon') return count + 1;
    return count + 1;
  }, 0);
};

const countFutureSkippedTiffins = (skippedDates = [], from = new Date()) => {
  if (!Array.isArray(skippedDates)) return 0;
  const cutoff = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 23, 59, 59);
  return skippedDates.reduce((count, entry) => {
    if (!entry) return count;
    const dateString = entry.date || entry;
    const time = entry.time || 'full_day';
    const targetDate = parseDateKeyAsLocal(String(dateString));
    if (!targetDate || targetDate.getTime() <= cutoff.getTime()) return count;
    if (time === 'full_day') return count + 2;
    if (time === 'morning' || time === 'afternoon') return count + 1;
    return count + 1;
  }, 0);
};

const getWeekdayName = (date = new Date()) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getDay()];
};

const buildTodaysMenuFromWeekly = (weeklyMenu) => {
  const dayName = getWeekdayName(new Date());
  const dayMenu = weeklyMenu?.[dayName] || {};
  const lunchItems = String(dayMenu.lunch || '').trim();
  const dinnerItems = String(dayMenu.dinner || '').trim();

  if (!lunchItems && !dinnerItems) {
    return null;
  }

  return {
    day: dayName,
    lunch: { time: '12:30 PM', items: lunchItems || 'No lunch menu set.' },
    dinner: dinnerItems ? { time: '8:00 PM', items: dinnerItems } : null
  };
};

const adjustVendorSubscriptionsEndDate = async (vendorId, daysDelta) => {
  const subscriptions = await Subscription.find({
    vendor: vendorId,
    status: { $in: ['active', 'paused'] }
  }).select('_id endDate');

  if (!subscriptions.length) {
    return 0;
  }

  const bulkOps = subscriptions.map((sub) => {
    const currentEndDate = new Date(sub.endDate);
    const nextEndDate = new Date(currentEndDate.getTime() + (daysDelta * ONE_DAY_MS));
    return {
      updateOne: {
        filter: { _id: sub._id },
        update: { $set: { endDate: nextEndDate } }
      }
    };
  });

  await Subscription.bulkWrite(bulkOps);
  return subscriptions.length;
};

// Helper function to convert Map to plain object for JSON response
const convertMapToObject = (map) => {
  const obj = {};
  for (const [key, value] of map.entries()) {
    obj[key] = value;
  }
  return obj;
};

// Helper function to convert plain object back to Map
const objectToMap = (obj) => {
  const map = new Map();
  for (const [key, value] of Object.entries(obj)) {
    map.set(key, value);
  }
  return map;
};

// GET /api/vendor/dashboard
// Fetch dashboard data for a vendor (analytics, pending requests, etc.)
exports.getVendorDashboard = async (req, res) => {
  try {
    const vendorId = req.user.userId; // From the JWT token

    // 1. Get the vendor's profile
    const vendorProfile = await VendorProfile.findOne({ vendorId });
    
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    // 2. Get all pending subscription requests for this vendor
    const pendingRequests = await Subscription.find({
      vendor: vendorProfile._id,
      status: 'pending'
    }).populate('customer', 'name email phone'); // Get customer details

    // 2b. Get all pending trial tiffin requests for this vendor
    const pendingTrials = await TrialOrder.find({
      vendor: vendorProfile._id,
      status: 'pending'
    }).populate('customer', 'name phone location roomNumber');

    // 3. Get all active subscriptions for this vendor
    const activeSubscriptions = await Subscription.find({
      vendor: vendorProfile._id,
      status: 'active'
    }).populate('customer', 'name email phone');
const ongoingSubscriptions = activeSubscriptions.filter(sub => {
      const planType = (sub.planType || '').toLowerCase();
      let baseDuration = 30; // Default monthly
      if (planType.includes('weekly') || planType.includes('7_days')) baseDuration = 7;
      else if (planType.includes('15_days')) baseDuration = 15;
      else if (planType.includes('single') || planType.includes('trial')) baseDuration = 1;

      let extensionDays = 0;
      if (sub.skippedDates && sub.skippedDates.length > 0) {
        const sessionsPerDay = planType.includes('full') ? 2 : 1;
        let skippedMeals = 0;
        sub.skippedDates.forEach(item => {
          if (!item) return;
          const time = item.time || 'full_day';
          if (time === 'full_day') skippedMeals += 2;
          else skippedMeals += 1;
        });
        extensionDays = Math.ceil(skippedMeals / sessionsPerDay);
      }

      const startDate = new Date(sub.startDate || sub.createdAt);
      startDate.setHours(0, 0, 0, 0); // Set to midnight
      
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + baseDuration + extensionDays - 1); // Subtract 1 because start date is day 1
      
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Set to midnight
      
      // Keep it ONLY if today is before or equal to the end date
      return today <= endDate; 
    });
    const homemadeOrderCount = await HomemadeOrder.countDocuments({ vendor: vendorProfile._id });
    const homemadePendingOrders = await HomemadeOrder.countDocuments({
      vendor: vendorProfile._id,
      status: { $in: ['placed', 'confirmed'] }
    });

const uniqueCustomers = await Subscription.distinct('customer', { vendor: vendorProfile._id, status: 'active' });
const totalCustomers = uniqueCustomers.length;
    const monthlyRevenue = activeSubscriptions.reduce((sum, sub) => sum + sub.price, 0);
    const now = new Date();
    const dailyMenuDoc = await DailyMenu.findOne(
      buildTodayMenuQuery(vendorProfile._id, now)
    ).lean();

    const todaysMenu = dailyMenuDoc
      ? {
          ...dailyMenuDoc,
          day: dailyMenuDoc.day || now.toLocaleDateString('en-US', { weekday: 'long', timeZone: IST_TIME_ZONE }),
        }
      : null;
    const todayKey = normalizeDateKey(new Date());
    const todayHolidayCount = activeSubscriptions.reduce((count, sub) => {
      if (Array.isArray(sub.skippedDates) && sub.skippedDates.some(entry => entry?.date === todayKey)) {
        return count + 1;
      }
      return count;
    }, 0);

    res.status(200).json({
      vendorProfile,
      pendingRequests,
      pendingTrials,
      activeSubscriptions,
      todaysMenu,
      stats: {
        totalCustomers,
        monthlyRevenue,
        totalSubscriptions: ongoingSubscriptions.length,
        pendingRequestsCount: pendingRequests.length + pendingTrials.length,
        pendingTrialsCount: pendingTrials.length,
        homemadeOrders: homemadeOrderCount,
        homemadePendingOrders,
        todayHolidayCount
      }
    });

  } catch (error) {
    console.error("Vendor Dashboard Error:", error);
    res.status(500).json({ message: 'Server error fetching vendor dashboard' });
  }
};

// GET /api/vendor/reviews
exports.getVendorReviews = async (req, res) => {
  try {
    const vendorId = req.user.userId || req.user.id;

    // 1. Get the vendor's current overall stats
    const profile = await VendorProfile.findOne({ vendorId: vendorId })
      .select('rating totalReviews');

    if (!profile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    // 2. Fetch all reviews for this kitchen
    // We use .populate() to get the student's name and room number so the vendor knows who wrote it!
    const reviews = await Review.find({ vendorId: profile._id })
      .populate('customerId', 'name roomNumber location')
      .sort({ createdAt: -1 }); // Newest reviews first

    // 3. Send it to the Flutter app
    res.status(200).json({
      averageRating: profile.rating || 0,
      totalReviews: profile.totalReviews || 0,
      reviews: reviews
    });

  } catch (error) {
    console.error("Error fetching vendor reviews:", error);
    res.status(500).json({ message: 'Server error fetching reviews' });
  }
};
// POST /api/vendor/approve-request/:subscriptionId
exports.approveSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) {
      return res.status(404).json({ message: 'Request not found.' });
    }

    if (subscription.status !== 'pending') {
      return res.status(400).json({ message: 'This request has already been processed.' });
    }

    // 1. Flip status to active
    subscription.status = 'active';

    // 🚨 2. THE 15-DAY AUTO-DEADLINE 🚨
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 15); // Adds exactly 15 days to right now
    subscription.paymentDeadline = deadline;

    await subscription.save();

    res.status(200).json({ 
      message: 'Student approved! They have 15 days to clear their payment.',
      subscription 
    });

  } catch (error) {
    console.error("Error approving subscription:", error);
    res.status(500).json({ message: 'Server error while approving.' });
  }
};

// POST /api/vendor/reject-request/:subscriptionId
// Vendor rejects a pending subscription request
exports.rejectSubscriptionRequest = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const vendorId = req.user.userId;

    const subscription = await Subscription.findById(subscriptionId);

    if (!subscription) {
      return res.status(404).json({ message: 'Subscription request not found' });
    }

    const vendorProfile = await VendorProfile.findOne({ vendorId });
    if (subscription.vendor.toString() !== vendorProfile._id.toString()) {
      return res.status(403).json({ message: 'Unauthorized: This is not your request' });
    }

    // Reject: zero out the bill so no ghost debt appears in Digital Khata
    subscription.status = 'cancelled';
    subscription.totalBill = 0;
    subscription.paymentStatus = 'paid'; // A 0 bill means nothing is owed
    await subscription.save();

    res.status(200).json({ message: 'Subscription rejected!', subscription });

  } catch (error) {
    console.error("Rejection Error:", error);
    res.status(500).json({ message: 'Server error rejecting request' });
  }
};

// --- 1. Fetch Students (Pending & Active) ---
exports.getVendorStudents = async (req, res) => {
  try {
    const userId = req.user.userId;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });

    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    // Find all subscriptions linked to this vendor, and populate the customer's name and email!
    const students = await Subscription.find({ vendor: vendorProfile._id })
      .populate('customer', 'name email location') 
      .sort({ createdAt: -1 });

    res.status(200).json(students);
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ message: 'Server error fetching students' });
  }
};

exports.getVendorSubscriptions = async (req, res) => {
  try {
    const userId = req.user.userId;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const subscriptions = await Subscription.find({ vendor: vendorProfile._id })
      .populate('customer', 'name phone location roomNumber')
      .sort({ createdAt: -1 });

    res.status(200).json(subscriptions);
  } catch (error) {
    console.error("Error fetching vendor subscriptions:", error);
    res.status(500).json({ message: 'Server error fetching subscriptions' });
  }
};

// --- 2. Update Request Status (Accept/Decline) ---
exports.updateRequestStatus = async (req, res) => {
  try {
    const { subscriptionId, status } = req.body; // status will be 'active' or 'cancelled'

    // Find the subscription and update its status
    const updatedSubscription = await Subscription.findByIdAndUpdate(
      subscriptionId,
      { status: status },
      { new: true }
    ).populate('customer', 'name');

    if (!updatedSubscription) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    res.status(200).json({ 
      message: `Request successfully marked as ${status}`, 
      subscription: updatedSubscription 
    });
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({ message: 'Server error updating status' });
  }
};
// --- Fetch Menu & Announcements ---
exports.getCommunicationData = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId });
    if (!vendorProfile) return res.status(404).json({ message: 'Profile not found' });

    const announcements = await Announcement.find({ vendor: vendorProfile._id })
      .sort({ createdAt: -1 })
      .limit(20);

    // Expose customPlans so the Flutter announcement screen can show real plan names
    const customPlans = vendorProfile.customPlans || [];

    res.status(200).json({
      weeklyMenu: vendorProfile.weeklyMenu,
      announcements,
      customPlans
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// --- Update Weekly Menu ---
exports.updateWeeklyMenu = async (req, res) => {
  try {
    const { weeklyMenu } = req.body;
    if (!weeklyMenu || typeof weeklyMenu !== 'object') {
      return res.status(400).json({ message: 'weeklyMenu is required.' });
    }
    
    const updatedProfile = await VendorProfile.findOneAndUpdate(
      { vendorId: req.user.userId },
      { weeklyMenu: weeklyMenu },
      { new: true }
    );
    if (!updatedProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    res.status(200).json({ message: 'Menu updated successfully!', weeklyMenu: updatedProfile.weeklyMenu });
  } catch (error) {
    res.status(500).json({ message: 'Server error updating menu' });
  }
};

// --- Post Announcement ---
exports.postAnnouncement = async (req, res) => {
  try {
    const { type, text, options } = req.body;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'Announcement text is required.' });
    }

    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const announcementData = {
      vendor: vendorProfile._id,
      type: type || 'General',
      text: String(text).trim(),
    };

    // Both 'Poll' and 'Meal Selection' types store voteable options
    if (type === 'Poll' || type === 'Meal Selection') {
      const { isMealSelection, targetDateKey, targetSession } = req.body;
      if (!Array.isArray(options)) {
        return res.status(400).json({ message: 'Poll options are required.' });
      }

      const optionObjects = options
        .map((option) => {
          if (typeof option === 'string') {
            return { text: option.trim() };
          }
          if (option && typeof option === 'object' && option.text) {
            return { text: String(option.text).trim() };
          }
          return null;
        })
        .filter((item) => item != null && item.text)
        .map((item) => ({ text: item.text }));

      if (optionObjects.length < 2) {
        return res.status(400).json({ message: 'Poll must have at least 2 non-empty options.' });
      }

      // Server-side cap: max 4 options (client enforces this too, but never trust the client)
      if (optionObjects.length > 4) {
        return res.status(400).json({ message: 'Poll cannot have more than 4 options.' });
      }

      announcementData.options = optionObjects;

      // For Meal Selection polls, store the date and session metadata
      if (isMealSelection === true || type === 'Meal Selection') {
        announcementData.isMealSelection = true;
        if (targetDateKey) announcementData.targetDateKey = targetDateKey;
        if (targetSession) announcementData.targetSession = targetSession;
      }
    }

    // 2. Create the document
    await Announcement.create(announcementData);

    // 3. Fetch the updated list
    const announcements = await Announcement.find({ vendor: vendorProfile._id })
      .sort({ createdAt: -1 })
      .limit(20);

    res.status(201).json({ message: 'Announcement posted! It will auto-delete in 24 hours.', announcements });

    // --- TRIGGER 3: Notify all active customers of the new announcement (fire-and-forget) ---
    try {
      const activeSubscriptions = await Subscription.find({
        vendor: vendorProfile._id,
        status: 'active',
      }).select('customer').lean();

      const customerIds = activeSubscriptions.map((s) => s.customer);
      const customerUsers = await User.find(
        { _id: { $in: customerIds }, fcmToken: { $ne: null } },
        { fcmToken: 1 },
      ).lean();

      const vendorName = vendorProfile.businessName ?? 'Your Kitchen';
      // Truncate announcement text to 80 chars for the notification body
      const notifBody = String(announcementData.text).slice(0, 80);

      await Promise.allSettled(
        customerUsers.map((u) =>
          sendPushNotification(
            u.fcmToken,
            `New Message from ${vendorName} 📢`,
            notifBody,
          )
        )
      );
    } catch (notifErr) {
      console.error('Customer announcement notification error (Trigger 3):', notifErr);
    }
  } catch (error) {
    console.error("Error posting announcement:", error);
    res.status(500).json({ message: 'Server error posting announcement' });
  }
};

// --- Get Daily Delivery List (Smart Grouping & Holiday Filter) ---


// --- 1. Fetch Students (Pending & Active) ---
exports.getVendorStudents = async (req, res) => {
  try {
    const userId = req.user.userId;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });

    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    // UPDATE THIS LINE to include phone and roomNumber
    const students = await Subscription.find({ vendor: vendorProfile._id })
      .populate('customer', 'name email phone location roomNumber') 
      .sort({ createdAt: -1 });

    res.status(200).json(students);
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ message: 'Server error fetching students' });
  }
};

// --- Get Vendor Profile Settings ---
exports.getVendorProfileSettings = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const user = await User.findById(userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor profile not found' });

    res.status(200).json({
      name: user.name,
      email: user.email,
      phone: vendorProfile.phone || user.phone,
      status: vendorProfile.status || 'pending',
      businessName: vendorProfile.businessName,
      serviceArea: vendorProfile.serviceArea,
      foodType: vendorProfile.foodType,
      // ✅ New flexible plans array (includes isActive)
      customPlans: vendorProfile.customPlans || [],
      vendorConsidersHolidays: vendorProfile.considersHolidays,
      // ✅ Minimum leave days threshold
      minimumHolidayDays: vendorProfile.minimumHolidayDays ?? 1,
      // ✅ Trial tiffin price
      trialPrice: vendorProfile.trialPrice ?? 0,
    });

  } catch (error) {
    console.error("Error fetching vendor profile settings:", error);
    res.status(500).json({ message: 'Server error fetching profile' });
  }
};

exports.updateVendorProfileSettings = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { 
      name, phone, businessName, serviceArea, foodType,
      customPlans,          // ✅ New flexible plans array (now includes isActive)
      vendorConsidersHolidays,
      minimumHolidayDays,   // ✅ Minimum leave days threshold
      trialPrice            // ✅ Trial tiffin price
    } = req.body;

    // 1. Initialize update objects
    const userUpdates = {};
    const vendorUpdates = {};

    if (name !== undefined) userUpdates.name = name;
    if (phone !== undefined) {
      userUpdates.phone = phone;
      vendorUpdates.phone = phone;
    }
    if (Object.keys(userUpdates).length > 0) {
      await User.findByIdAndUpdate(userId, userUpdates);
    }

    // 2. Build vendor business update payload
    if (businessName !== undefined)    vendorUpdates.businessName    = businessName;
    if (serviceArea !== undefined)     vendorUpdates.serviceArea     = serviceArea;
    if (foodType !== undefined)        vendorUpdates.foodType        = foodType;
    if (vendorConsidersHolidays !== undefined) vendorUpdates.considersHolidays = vendorConsidersHolidays;
    if (minimumHolidayDays !== undefined && !isNaN(Number(minimumHolidayDays))) {
      vendorUpdates.minimumHolidayDays = Math.max(1, Number(minimumHolidayDays));
    }
    // ✅ Replace entire plans array atomically (preserves isActive flag from client)
    if (Array.isArray(customPlans))    vendorUpdates.customPlans     = customPlans;
    // ✅ Trial tiffin price
    if (trialPrice !== undefined && !isNaN(Number(trialPrice))) {
      vendorUpdates.trialPrice = Math.max(0, Number(trialPrice));
    }

    const updatedProfile = await VendorProfile.findOneAndUpdate(
      { vendorId: userId },
      vendorUpdates,
      { new: true, runValidators: true }
    );

    res.status(200).json({ message: 'Profile updated successfully!', profile: updatedProfile });

  } catch (error) {
    console.error("Error updating vendor profile:", error);
    res.status(500).json({ message: 'Server error updating profile' });
  }
};

// --- Get Payment Status (Unpaid vs Paid) ---
exports.getPaymentRecords = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor profile not found' });

    const activeSubs = await Subscription.find({ 
      vendor: vendorProfile._id, 
      status: 'active' 
    }).populate('customer', 'name phone location roomNumber');

    const unpaidCustomers = [];
    const paidCustomers = [];
    const today = new Date();

    activeSubs.forEach(sub => {
      if (!sub.customer) return;

      const planSessions = getPlanSessionCount(sub.planType);
      const totalTiffins = sub.totalTiffins || getTotalTiffins(sub.planType);
      const skippedTiffins = countSkippedTiffins(sub.skippedDates, today);
      const futureSkippedTiffins = countFutureSkippedTiffins(sub.skippedDates, today);
      const startDate = new Date(sub.startDate || sub.createdAt);
      const elapsedDays = today < startDate ? 0 : Math.floor((today.getTime() - startDate.getTime()) / ONE_DAY_MS) + 1;
      const deliveredSoFar = Math.max(0, Math.min(totalTiffins, elapsedDays * planSessions - skippedTiffins));
      const tiffinsLeft = Math.max(0, totalTiffins - deliveredSoFar - futureSkippedTiffins);

      // Format the Exact Date and Time for the Receipt!
      const formattedPaymentDate = sub.lastPaymentDate 
        ? new Date(sub.lastPaymentDate).toLocaleString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
          }) 
        : 'Not Paid Yet';

      const customerData = {
        id: sub._id,
        name: sub.customer.name,
        amount: sub.price,
        hostel: sub.customer.location || 'N/A',
        room: sub.customer.roomNumber || '',
        phone: sub.customer.phone || '',
        plan: `${sub.planType.replace('_', ' ')} (${sub.mealType})`,
        leaves: skippedTiffins,
        futureLeaves: futureSkippedTiffins,
        totalTiffins,
        tiffinsLeft,
        exactPaymentDate: formattedPaymentDate // Send the exact time to React
      };

      // NEW LOGIC: If they explicitly have 'unpaid' status OR they have 3 or fewer tiffins left
      if (sub.paymentStatus === 'unpaid' || tiffinsLeft <= 3) {
        let dueText = "Due soon";
        
        if (sub.paymentStatus === 'unpaid') {
          dueText = "New Request (Unpaid)";
        } else if (tiffinsLeft === 0) {
          dueText = "Due now";
        } else {
          dueText = `Only ${tiffinsLeft} tiffins left`;
        }

        unpaidCustomers.push({ ...customerData, due: dueText });
      } else {
        // They are Paid, Active, and have plenty of days left
        paidCustomers.push({ 
          ...customerData, 
          date: customerData.exactPaymentDate, // This now contains Date + Time
          method: "Cash / UPI" 
        });
      }
    });

    res.status(200).json({ unpaidCustomers, paidCustomers });
  } catch (error) {
    console.error("Error fetching payment records:", error);
    res.status(500).json({ message: 'Server error fetching payments' });
  }
};

// --- Mark Student as Paid (Renew Subscription) ---
exports.markAsPaid = async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    if (String(subscription.vendor) !== String(vendorProfile._id)) {
      return res.status(403).json({ message: 'Unauthorized payment update request' });
    }

    if (subscription.status !== 'active') {
      return res.status(400).json({ message: 'Only active subscriptions can be marked as paid' });
    }

    // Update payment status and renew plan window from now.
    subscription.startDate = new Date();
    subscription.skippedDates = [];
    subscription.paymentStatus = 'paid';
    subscription.lastPaymentDate = new Date();
    const updatedSub = await subscription.save();

    if (!updatedSub) return res.status(404).json({ message: 'Subscription not found' });

    res.status(200).json({ message: 'Payment recorded successfully!' });
  } catch (error) {
    res.status(500).json({ message: 'Server error updating payment' });
  }
};

// --- Manual trigger for testing delivery updates (development only) ---
exports.triggerDeliveryUpdate = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const { session } = req.body; // 'morning' or 'afternoon'
    if (!session || !['morning', 'afternoon'].includes(session)) {
      return res.status(400).json({ message: 'Invalid session. Must be "morning" or "afternoon"' });
    }

    const deliveryScheduler = require('../services/deliveryScheduler');
    await deliveryScheduler.updateDeliveriesForSession(vendorProfile._id, session);

    res.status(200).json({ message: `Delivery counts updated for ${session} session` });
  } catch (error) {
    console.error('Error triggering delivery update:', error);
    res.status(500).json({ message: 'Server error updating deliveries' });
  }
};

// --- Homemade Inventory (Vendor) ---
exports.getVendorHomemadeItems = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const items = await HomemadeItem.find({ vendor: vendorProfile._id }).sort({ createdAt: -1 });
    res.status(200).json(items);
  } catch (error) {
    console.error("Error fetching vendor homemade items:", error);
    res.status(500).json({ message: 'Server error fetching homemade items' });
  }
};
exports.markDeliveryComplete = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { session } = req.body; // 'morning' or 'afternoon'

    // 1. Find the subscription
    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) return res.status(404).json({ message: 'Subscription not found' });

    if (subscription.status !== 'active') {
      return res.status(400).json({ message: 'This subscription is not active.' });
    }

    // Set time to IST to ensure exact date matches
    const today = new Date();
    today.setHours(today.getHours() + 5);
    today.setMinutes(today.getMinutes() + 30);
    const todayString = today.toISOString().split('T')[0];

    // 2. Prevent double-marking
    const existingDelivery = await DeliveryStatus.findOne({
      subscription: subscriptionId,
      dateKey: todayString,
      session: session
    });

    if (existingDelivery) {
      return res.status(400).json({ message: 'Meal already marked delivered for this session.' });
    }

    // 3. Mark it delivered 
    await DeliveryStatus.create({
      vendor: subscription.vendor,
      customer: subscription.customer, 
      subscription: subscriptionId,
      dateKey: todayString,
      session: session,
      status: 'delivered'
    });

    // 🚨 WE DELETED THE "remainingTiffins -= 1" MATH! 🚨
    // The calendar engine handles the plan duration naturally now.

    res.status(200).json({ 
      message: 'Delivery marked successfully!'
    });

  } catch (error) {
    console.error("Error marking delivery:", error);
    res.status(500).json({ message: 'Server error marking delivery' });
  }
};
exports.resetVendorDailyDeliveries = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const today = new Date();
    const todayDateString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dateKey = normalizeDateKey(req.body?.date) || todayDateString;

    const result = await DeliveryStatus.deleteMany({
      vendor: vendorProfile._id,
      dateKey
    });

    res.status(200).json({
      message: `Reset completed. ${result.deletedCount || 0} delivered meal record(s) moved back to drop-off.`,
      deletedCount: result.deletedCount || 0,
      date: dateKey
    });
  } catch (error) {
    console.error("Error resetting vendor daily deliveries:", error);
    res.status(500).json({ message: 'Server error resetting deliveries' });
  }
};

exports.createVendorHomemadeItem = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const {
      name,
      category,
      price,
      unit,
      description,
      imageUrl,
      inStock,
      stockQuantity
    } = req.body;

    if (!name || price === undefined || price === null || String(name).trim() === '') {
      return res.status(400).json({ message: 'name and price are required.' });
    }

    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ message: 'price must be a valid number greater than 0.' });
    }

    const parsedStockRaw = Number(stockQuantity);
    const parsedStock = Number.isFinite(parsedStockRaw) ? Math.max(0, Math.floor(parsedStockRaw)) : 0;
    const parsedInStock = parseBoolean(inStock, true) && parsedStock > 0;

    const item = await HomemadeItem.create({
      vendor: vendorProfile._id,
      name: String(name).trim(),
      category: category ? String(category).trim() : 'Other',
      price: parsedPrice,
      unit: unit ? String(unit).trim() : 'per unit',
      description: description ? String(description).trim() : '',
      imageUrl: imageUrl ? String(imageUrl).trim() : '',
      stockQuantity: parsedStock,
      inStock: parsedInStock
    });

    await HomemadeStockLog.create({
      vendor: vendorProfile._id,
      item: item._id,
      action: 'item_created',
      quantityChange: parsedStock,
      previousStock: 0,
      newStock: parsedStock,
      note: 'Initial stock set while creating item'
    });

    res.status(201).json({ message: 'Item added to inventory.', item });
  } catch (error) {
    console.error("Error creating homemade item:", error);
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error creating homemade item' });
  }
};

exports.restockVendorHomemadeItem = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const { itemId } = req.params;
    const addQuantity = Math.floor(Number(req.body.quantity));
    if (!Number.isFinite(addQuantity) || addQuantity <= 0) {
      return res.status(400).json({ message: 'quantity must be a positive integer.' });
    }

    const item = await HomemadeItem.findOne({ _id: itemId, vendor: vendorProfile._id });
    if (!item) {
      return res.status(404).json({ message: 'Item not found.' });
    }

    const previousStock = item.stockQuantity;
    item.stockQuantity += addQuantity;
    if (item.stockQuantity > 0) {
      item.inStock = true;
    }
    await item.save();

    await HomemadeStockLog.create({
      vendor: vendorProfile._id,
      item: item._id,
      action: 'restock',
      quantityChange: addQuantity,
      previousStock,
      newStock: item.stockQuantity,
      note: req.body.note ? String(req.body.note).trim() : 'Manual restock by vendor'
    });

    res.status(200).json({ message: 'Item restocked successfully.', item });
  } catch (error) {
    console.error("Error restocking homemade item:", error);
    res.status(500).json({ message: 'Server error restocking homemade item' });
  }
};

exports.updateVendorHomemadeItem = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const { itemId } = req.params;
    const item = await HomemadeItem.findOne({ _id: itemId, vendor: vendorProfile._id });
    if (!item) {
      return res.status(404).json({ message: 'Item not found.' });
    }

    if (req.body.name !== undefined) item.name = String(req.body.name).trim();
    if (req.body.category !== undefined) item.category = String(req.body.category).trim();
    if (req.body.unit !== undefined) item.unit = String(req.body.unit).trim();
    if (req.body.description !== undefined) item.description = String(req.body.description).trim();
    if (req.body.imageUrl !== undefined) item.imageUrl = String(req.body.imageUrl).trim();
    if (req.body.isActive !== undefined) item.isActive = parseBoolean(req.body.isActive, item.isActive);
    if (req.body.inStock !== undefined) item.inStock = parseBoolean(req.body.inStock, item.inStock);
    if (req.body.price !== undefined) {
      const parsedPrice = Number(req.body.price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ message: 'price must be a valid number greater than 0.' });
      }
      item.price = parsedPrice;
    }
    if (req.body.stockQuantity !== undefined) {
      const parsedStockRaw = Number(req.body.stockQuantity);
      if (!Number.isFinite(parsedStockRaw) || parsedStockRaw < 0) {
        return res.status(400).json({ message: 'stockQuantity must be a valid number 0 or more.' });
      }
      item.stockQuantity = Math.floor(parsedStockRaw);
    }

    if (Number(item.stockQuantity) <= 0) {
      item.stockQuantity = 0;
      item.inStock = false;
    }

    await item.save();
    res.status(200).json({ message: 'Inventory item updated.', item });
  } catch (error) {
    console.error("Error updating homemade item:", error);
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error updating homemade item' });
  }
};

exports.getVendorHomemadeOrders = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const orders = await HomemadeOrder.find({ vendor: vendorProfile._id })
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 });

    const formattedOrders = orders.map((order) => ({
      _id: order._id,
      itemId: order.item,
      itemName: order.itemName,
      itemUnit: order.itemUnit,
      quantity: order.quantity,
      totalAmount: order.totalAmount,
      status: order.status,
      customerName: order.customer?.name || 'Unknown Customer',
      customerPhone: order.customer?.phone || '',
      createdAt: order.createdAt
    }));

    res.status(200).json(formattedOrders);
  } catch (error) {
    console.error("Error fetching vendor homemade orders:", error);
    res.status(500).json({ message: 'Server error fetching homemade orders' });
  }
};

exports.updateVendorHomemadeOrderStatus = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const { orderId } = req.params;
    const { status } = req.body;
    const allowedStatuses = ['confirmed', 'delivered', 'cancelled'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status update.' });
    }

    const order = await HomemadeOrder.findOne({ _id: orderId, vendor: vendorProfile._id });
    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.status === 'delivered' || order.status === 'cancelled') {
      return res.status(400).json({ message: `Order already ${order.status}.` });
    }

    // If vendor cancels, restore stock back.
    if (status === 'cancelled' && order.status !== 'cancelled') {
      const item = await HomemadeItem.findById(order.item);
      if (item) {
        const previousStock = item.stockQuantity;
        item.stockQuantity += order.quantity;
        if (item.stockQuantity > 0) {
          item.inStock = true;
        }
        await item.save();

        await HomemadeStockLog.create({
          vendor: vendorProfile._id,
          item: item._id,
          order: order._id,
          action: 'order_cancelled_restore',
          quantityChange: order.quantity,
          previousStock,
          newStock: item.stockQuantity,
          note: 'Stock restored after order cancellation'
        });
      }
    }

    order.status = status;
    await order.save();

    res.status(200).json({ message: `Order marked as ${status}.`, order });
  } catch (error) {
    console.error("Error updating homemade order status:", error);
    res.status(500).json({ message: 'Server error updating homemade order status' });
  }
};

exports.getVendorHomemadeStockLogs = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const logs = await HomemadeStockLog.find({ vendor: vendorProfile._id })
      .populate('item', 'name')
      .sort({ createdAt: -1 })
      .limit(100);

    const formattedLogs = logs.map((log) => ({
      _id: log._id,
      itemName: log.item?.name || 'Unknown Item',
      action: log.action,
      quantityChange: log.quantityChange,
      previousStock: log.previousStock,
      newStock: log.newStock,
      note: log.note,
      createdAt: log.createdAt
    }));

    res.status(200).json(formattedLogs);
  } catch (error) {
    console.error("Error fetching stock logs:", error);
    res.status(500).json({ message: 'Server error fetching stock logs' });
  }
};

// --- Vendor Holidays (DB-backed) 
// GET /api/vendor/holidays
exports.getVendorHolidays = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor profile not found' });

    // Fetch holidays and sort them by newest date first
    const holidays = await VendorHoliday.find({ vendor: vendorProfile._id }).sort({ dateKey: -1 });
    res.status(200).json(holidays);
  } catch (error) {
    console.error("Error fetching vendor holidays:", error);
    res.status(500).json({ message: 'Server error while fetching holidays' });
  }
};

// DELETE /api/vendor/holidays/:id
exports.deleteVendorHoliday = async (req, res) => {
  try {
    const { id } = req.params;
    const holiday = await VendorHoliday.findById(id);
    
    if (!holiday) return res.status(404).json({ message: 'Holiday not found' });

    // 🚨 ENTERPRISE SAFETY CHECK: Prevent deleting past holidays
    const holidayDate = new Date(holiday.dateKey);
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset time to midnight for accurate day comparison

    if (holidayDate < today) {
      return res.status(400).json({ message: 'You cannot delete a holiday from the past.' });
    }

    const time = holiday.time; // 'morning', 'afternoon', 'full_day'

    // 1. Fetch currently active subscriptions to reverse the extension
    const activeSubs = await Subscription.find({ vendor: holiday.vendor, status: 'active' });

    const savePromises = activeSubs.map(async (sub) => {
      let requiresSave = false;
      const isLunchOnly = sub.preferredSession === 'morning';
      const isDinnerOnly = sub.preferredSession === 'afternoon';

      // Did this specific student get an extension for this holiday type?
      const gotExtended = time === 'full_day' || (time === 'morning' && isLunchOnly) || (time === 'afternoon' && isDinnerOnly);

      // If they got an extension, REVERSE IT safely
      if (gotExtended && sub.vendorExtensionDays && sub.vendorExtensionDays > 0) {
        sub.vendorExtensionDays -= 1;
        // Subtract 1 day (24 hours) from their end date
        sub.endDate = new Date(sub.endDate.getTime() - 24 * 60 * 60 * 1000);
        requiresSave = true;
      }

      if (requiresSave) return sub.save();
    });

    // Execute all reversals
    await Promise.all(savePromises);

    // 2. Finally, delete the holiday record from the database
    await VendorHoliday.findByIdAndDelete(id);

    res.status(200).json({ message: 'Holiday deleted successfully. Student plans have been reverted.' });
  } catch (error) {
    console.error("Error deleting vendor holiday:", error);
    res.status(500).json({ message: 'Server error while deleting holiday' });
  }
};

// POST /api/vendor/holidays
// POST /api/vendor/holidays
exports.addVendorHoliday = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found' });
    }

    const { date, reason, time } = req.body; 
    // time will be: 'morning', 'afternoon', or 'full_day'

    if (!date || !time) {
      return res.status(400).json({ message: 'Date and time of closure are required.' });
    }

    // 1. Save the closure to the database
    await VendorHoliday.create({
      vendor: vendorProfile._id, 
      dateKey: date,
      reason: reason || 'Emergency Kitchen Closure',
      time: time
    });

    // 2. Fetch all Currently Active Subscriptions for THIS kitchen
    const activeSubs = await Subscription.find({ 
      vendor: vendorProfile._id, 
      status: 'active' 
    });

    // 3. The New Logic: Check plan type before extending!
    const savePromises = activeSubs.map(async (sub) => {
      let requiresSave = false;

      // Identify what kind of plan they have
      const isLunchOnly = sub.preferredSession === 'morning';
      const isDinnerOnly = sub.preferredSession === 'afternoon';
      const isBothMeals = sub.preferredSession === 'both';

      // SCENARIO 1: Vendor marks ENTIRE DAY
      if (time === 'full_day') {
        // Extend EVERYONE by 1 day
        sub.endDate = new Date(sub.endDate.getTime() + 24 * 60 * 60 * 1000);
        requiresSave = true;
      } 
      
      // SCENARIO 2: Vendor marks LUNCH ONLY
      else if (time === 'morning') {
        // ONLY extend if they are a Lunch-Only student!
        // (Full-plan and Dinner-only students get NO extension)
        if (isLunchOnly) {
          sub.endDate = new Date(sub.endDate.getTime() + 24 * 60 * 60 * 1000);
          requiresSave = true;
        }
      } 
      
      // SCENARIO 3: Vendor marks DINNER ONLY
      else if (time === 'afternoon') {
        // ONLY extend if they are a Dinner-Only student!
        // (Full-plan and Lunch-only students get NO extension)
        if (isDinnerOnly) {
          sub.endDate = new Date(sub.endDate.getTime() + 24 * 60 * 60 * 1000);
          requiresSave = true;
        }
      }

      // Save to database only if we extended their date
      if (requiresSave) {
        return sub.save();
      }
    });

    // Execute all database saves simultaneously
    await Promise.all(savePromises);
// 🚨 NEW NOTIFICATION CODE STARTS HERE 🚨
    // Alert all active students about the holiday
    for (let sub of activeSubs) {
      const studentUser = await User.findById(sub.customer);
      if (studentUser && studentUser.fcmToken) {
        let mealText = time === 'full_day' ? 'for the entire day' : `for ${time}`;
        await sendPushNotification(
          studentUser.fcmToken,
          "Kitchen Holiday Alert 🏖️",
          `${vendorProfile.businessName} is closed ${mealText} on ${date}. Your plan has been adjusted!`
        );
      }
    }
    res.status(201).json({ 
      message: 'Holiday declared successfully. Eligible plans have been extended by 1 day!' 
    });

  } catch (error) {
    console.error("Error declaring vendor holiday:", error);
    res.status(500).json({ message: 'Server error while declaring holiday' });
  }
};

// POST /api/vendor/register
// Automatically creates the MongoDB user after Firebase signup
exports.registerNewVendor = async (req, res) => {
  try {
    const { name, phone, businessName, serviceArea, foodType } = req.body;
    const { uid, email } = req.firebaseUser; // Coming from our new middleware!

    // 1. Check if they somehow already exist in MongoDB
    const existingUser = await User.findOne({ firebaseUid: uid });
    if (existingUser) {
      return res.status(400).json({ message: 'Vendor already registered in database.' });
    }

    // 2. Create the core User document
    const newUser = await User.create({
      firebaseUid: uid,
      name: name,
      email: email,
      phone: phone,
      role: 'vendor'
    });

    // 3. Create their Vendor Profile linked to the User document
    const newVendorProfile = await VendorProfile.create({
      vendorId: newUser._id,
      ownerName: name,
      businessName: businessName,
      phone: phone || '',
      serviceArea: serviceArea || '',
      foodType: foodType || 'Mix',
      status: 'pending' // You can change to 'approved' for testing without an admin
    });

    res.status(201).json({ 
      message: 'Vendor successfully registered!', 
      user: newUser,
      profile: newVendorProfile
    });

  } catch (error) {
    console.error("Registration Error:", error);
    res.status(500).json({ message: 'Server error during registration' });
  }
};

// GET /api/vendor/subscriptions/pending
exports.getPendingRequests = async (req, res) => {
  try {
    // 1. Find the vendor's profile using their authenticated User ID
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found.' });
    }

    // 2. Fetch all subscriptions linked to this kitchen that are 'pending'
    // Also treat older documents without the status field as pending for backward compatibility.
    const pendingRequests = await Subscription.find({
      vendor: vendorProfile._id,
      $or: [{ status: 'pending' }, { status: { $exists: false } }]
    }).populate('customer', 'name phone location roomNumber'); // Pulls student info automatically

    // 3. Fetch all pending TrialOrders for this vendor
    const pendingTrials = await TrialOrder.find({
      vendor: vendorProfile._id,
      status: 'pending'
    }).populate('customer', 'name phone location roomNumber');

    const formattedTrials = pendingTrials.map(t => ({
      _id: t._id,
      customer: t.customer,
      planType: 'Trial Tiffin',
      planName: '1-Day Trial Tiffin',
      preferredSession: t.targetSession,
      targetDate: t.targetDate,
      price: t.price,
      isTrialOrder: true,
      createdAt: t.createdAt
    }));

    const combined = [...pendingRequests.map(r => r.toObject()), ...formattedTrials];
    combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.status(200).json(combined);
  } catch (error) {
    console.error("Error fetching pending requests:", error);
    res.status(500).json({ message: 'Server error fetching requests.' });
  }
};

// POST /api/vendor/subscriptions/respond
exports.respondToRequest = async (req, res) => {
  try {
    const { subscriptionId, action } = req.body; // action can be 'approve' or 'reject'
    const finalStatus = action === 'approve' ? 'active' : 'cancelled';

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action.' });
    }

    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found.' });
    }

    const update = { status: finalStatus };
    if (finalStatus === 'active') {
      const approvalDate = new Date();
      approvalDate.setHours(0, 0, 0, 0);

      // Derive duration from vendor's customPlans or planType
      const existingSub = await Subscription.findById(subscriptionId).select('planType');
      const planTypeStr = String(existingSub?.planType || '');

      let durationDays = 30;
      let matchedPlan = null;
      if (vendorProfile.customPlans && Array.isArray(vendorProfile.customPlans)) {
        matchedPlan = vendorProfile.customPlans.find(p => 
          p.planName.toLowerCase().trim() === planTypeStr.toLowerCase().trim() ||
          p.planName.toLowerCase().replace(/\s+/g, '_') === planTypeStr.toLowerCase()
        );
      }

      if (matchedPlan) {
        durationDays = Number(matchedPlan.durationDays) || 30;
      } else {
        const lower = planTypeStr.toLowerCase();
        if (lower.includes('weekly') || lower.includes('7_days')) durationDays = 7;
        else if (lower.includes('15_days') || lower.includes('15_day')) durationDays = 15;
        else if (lower.includes('single')) durationDays = 1;
      }

      const approvalEndDate = new Date(approvalDate);
      approvalEndDate.setDate(approvalEndDate.getDate() + (durationDays - 1));

      update.startDate = approvalDate;
      update.endDate   = approvalEndDate;
    } else {
      // Rejected: zero out the bill so no ghost debt appears in Digital Khata
      update.totalBill = 0;
      update.paymentStatus = 'paid'; // A 0 bill means nothing is owed
    }

    const updatedSubscription = await Subscription.findOneAndUpdate(
      { _id: subscriptionId, vendor: vendorProfile._id },
      update,
      { new: true, runValidators: true }
    ).populate('customer', 'name phone location roomNumber email');

    if (!updatedSubscription) {
      return res.status(404).json({ message: 'Subscription request not found.' });
    }
// 🚨 NEW NOTIFICATION CODE STARTS HERE 🚨
    if (finalStatus === 'active') {
      const studentUser = await User.findById(updatedSubscription.customer._id);
      if (studentUser && studentUser.fcmToken) {
        await sendPushNotification(
          studentUser.fcmToken,
          "Plan Approved! 🍱",
          `${vendorProfile.businessName} has accepted your request. Tap to check your Khata!`
        );
      }
    }
    res.status(200).json({ 
      message: `Subscription successfully ${finalStatus}!`, 
      subscription: updatedSubscription 
    });
  } catch (error) {
    console.error("Error responding to subscription:", error);
    res.status(500).json({ message: 'Server error processing response.' });
  }
};
// GET /api/vendor/customers/active
exports.getActiveCustomers = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found.' });

    // Find ONLY active subscriptions and populate the student details
    const activeCustomers = await Subscription.find({
      vendor: vendorProfile._id,
      status: 'active'
    }).populate('customer', 'name phone location roomNumber email');

    res.status(200).json(activeCustomers);
  } catch (error) {
    console.error("Error fetching active customers:", error);
    res.status(500).json({ message: 'Server error fetching customers.' });
  }
};
// POST /api/vendor/menu/today
exports.updateDailyMenu = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found.' });
    }

    const { lunchItems, dinnerItems } = req.body;

    const now = new Date();
    const { dateKey, start: startOfDay, end: endOfDay } = getTodayMenuDateInfo(now);

    console.log('[DailyMenu:publish]', {
      vendorId: String(vendorProfile._id),
      serverNow: now.toISOString(),
      timeZone: IST_TIME_ZONE,
      dateKey,
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString(),
      hasLunch: Boolean(lunchItems),
      hasDinner: Boolean(dinnerItems),
    });

    const updatedMenu = await DailyMenu.findOneAndUpdate(
      buildTodayMenuQuery(vendorProfile._id, now),
      { $set: {
        vendor: vendorProfile._id,
        // Store the stable IST day boundary, not the Render server timestamp.
        date: startOfDay,
        dateKey,
        day: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: IST_TIME_ZONE }),
        lunch: { time: '12:30 PM', items: lunchItems || 'Not updated yet' },
        dinner: { time: '8:00 PM', items: dinnerItems || 'Not updated yet' }
      }},
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // 📋 DIAGNOSTIC LOG — confirm exactly what was saved to MongoDB
    console.log('VENDOR POSTED MENU:', {
      menuId: String(updatedMenu._id),
      vendorId: String(updatedMenu.vendor),
      dateKey: updatedMenu.dateKey,
      storedDate: updatedMenu.date.toISOString(),
      lunch: updatedMenu.lunch,
      dinner: updatedMenu.dinner,
    });

    res.status(200).json({ message: 'Menu published successfully!', menu: updatedMenu });

    // --- TRIGGER 2: Notify all active customers that today's menu is live (fire-and-forget) ---
    try {
      const activeSubscriptions = await Subscription.find({
        vendor: vendorProfile._id,
        status: 'active',
      }).select('customer').lean();

      const customerIds = activeSubscriptions.map((s) => s.customer);
      const customerUsers = await User.find(
        { _id: { $in: customerIds }, fcmToken: { $ne: null } },
        { fcmToken: 1 },
      ).lean();
    const vendorName = vendorProfile.businessName ?? 'Your Kitchen';

      await Promise.allSettled(
        customerUsers.map((u) =>
          sendPushNotification(
            u.fcmToken,
            "Today's Menu is Live 🍲",
            `Check out what ${vendorName} is cooking today!`,
          )
        )
      );
    } catch (notifErr) {
      console.error('Customer menu notification error (Trigger 2):', notifErr);
    }
  } catch (error) {
    console.error("Menu Update Error:", error);
    res.status(500).json({ message: 'Server error updating menu.' });
  }
};

// DELETE /api/vendor/menu/today
exports.deleteDailyMenu = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({
      vendorId: req.user.userId || req.user.id,
    });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found.' });
    }

    const now = new Date();
    const deletedMenu = await DailyMenu.findOneAndDelete(
      buildTodayMenuQuery(vendorProfile._id, now)
    );

    if (!deletedMenu) {
      return res.status(404).json({ message: "No menu found for today to delete." });
    }

    console.log('VENDOR DELETED MENU:', {
      menuId: String(deletedMenu._id),
      vendorId: String(deletedMenu.vendor),
      dateKey: deletedMenu.dateKey,
    });

    res.status(200).json({ message: "Today's menu deleted successfully!" });
  } catch (error) {
    console.error('Error deleting daily menu:', error);
    res.status(500).json({ message: 'Server error deleting daily menu' });
  }
};

// GET /api/vendor/deliveries/today
exports.getTodaysDeliveries = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found' });

    // Set time to IST
    const today = new Date();
    today.setHours(today.getHours() + 5);
    today.setMinutes(today.getMinutes() + 30);
    const todayString = today.toISOString().split('T')[0];

    // Create a strict midnight timestamp for calendar math
    const todayStart = new Date(todayString);
    todayStart.setHours(0, 0, 0, 0);

    // 1. Fetch active students whose endDate has not passed yet
    const activeSubscriptions = await Subscription.find({
      vendor: vendorProfile._id,
      status: 'active',
      endDate: { $gte: todayStart }
    }).populate('customer', 'name phone location roomNumber');

    // 🚨 2. THE NEW TIME-AWARE FILTER 🚨
    // This strips out any 'active' plan where the startDate is tomorrow or later!
    const validDeliveries = activeSubscriptions.filter(sub => {
      if (sub.startDate) {
        const start = new Date(sub.startDate);
        start.setHours(0, 0, 0, 0);
        if (start > todayStart) {
          return false; // HIDE IT! It is an upcoming plan.
        }
      }
      return true; // Keep it if it has started!
    });

    // 3. Fetch meals that have ALREADY been delivered today
    const deliveredRecords = await DeliveryStatus.find({
      vendor: vendorProfile._id,
      dateKey: todayString
    });

    const deliveredMorningIds = new Set();
    const deliveredAfternoonIds = new Set();
    deliveredRecords.forEach(record => {
      if (record.session === 'morning') deliveredMorningIds.add(record.subscription.toString());
      if (record.session === 'afternoon') deliveredAfternoonIds.add(record.subscription.toString());
    });

    // 🍽️ 3b. Fetch today's Meal Selection polls to override per-student mealType
    // morningVotes / afternoonVotes: { customerId(string) -> 'veg' | 'non-veg' }
    const morningVotes = {};
    const afternoonVotes = {};

    try {
      const todayPolls = await Announcement.find({
        vendor: vendorProfile._id,
        type: 'Meal Selection',
        targetDateKey: todayString
      }).lean();

      for (const poll of todayPolls) {
        const session = (poll.targetSession || 'morning').toLowerCase();
        const targetVotes = session === 'afternoon' ? afternoonVotes : morningVotes;

        if (Array.isArray(poll.options)) {
          for (const option of poll.options) {
            // Normalize option text: 'Non-Veg' → 'non-veg', 'Veg' → 'veg'
            const normalizedText = (option.text || '').trim().toLowerCase();
            const isNonVeg = normalizedText.includes('non');
            const mealLabel = isNonVeg ? 'non-veg' : 'veg';

            if (Array.isArray(option.voters)) {
              for (const voterId of option.voters) {
                targetVotes[voterId.toString()] = mealLabel;
              }
            }
          }
        }
      }
    } catch (pollErr) {
      // Non-fatal: if poll fetch fails, fall back to subscription mealType
      console.error('Meal Selection poll fetch error (non-fatal):', pollErr);
    }

    let morningPending = [];
    let afternoonPending = [];
    let morningDelivered = [];
    let afternoonDelivered = [];
    let studentsOnLeaveToday = [];

    // 🚨 4. Sort ONLY the Valid Deliveries into Lunch, Dinner, or Holiday
    validDeliveries.forEach(sub => {
      if (!sub.customer) return;

      const todayHoliday = sub.skippedDates?.find(d => d.date === todayString);
      const skippedTime = todayHoliday ? todayHoliday.time : null;

      const customerId = sub.customer._id.toString();

      // Apply poll vote → override sub.mealType if the student voted today
      const morningMealType = morningVotes[customerId] || (sub.mealType || 'veg').toLowerCase();
      const afternoonMealType = afternoonVotes[customerId] || (sub.mealType || 'veg').toLowerCase();

      const baseStudentData = {
        subscriptionId: sub._id,
        customerName: sub.customer.name || 'Unknown Student',
        roomNumber: sub.customer.roomNumber || 'N/A',
        location: sub.customer.location || 'Main Hostel',
        phone: sub.customer.phone || '',

        // 🚨 THE FIX: Add the Trial Flags for the Vendor UI!
        planType: sub.planType,
        isTrial: sub.planType === 'single',
        // If it's a single trial and they haven't paid yet, tell the vendor to collect cash!
        amountToCollect: (sub.planType === 'single' && sub.paymentStatus !== 'paid') ? sub.totalBill : 0
      };

      const subId = sub._id.toString();

      // Track if they are on leave today (use subscription default mealType for leave record)
      if (skippedTime) {
        studentsOnLeaveToday.push({
          ...baseStudentData,
          mealType: (sub.mealType || 'veg').toLowerCase(),
          leaveType: skippedTime // 'morning', 'afternoon', or 'full_day'
        });
      }

      // Instead of bundleType, we strictly look at their preferredSession
      let allowedSessions = [];
      if (sub.preferredSession === 'both') {
        allowedSessions = ['morning', 'afternoon'];
      } else {
        allowedSessions = [sub.preferredSession || 'morning'];
      }

      // 12:30 PM (LUNCH) SORTING — use morning poll vote for mealType
      if (allowedSessions.includes('morning') && skippedTime !== 'morning' && skippedTime !== 'full_day') {
        const morningStudentData = { ...baseStudentData, mealType: morningMealType, mealSlot: 'morning' };
        if (deliveredMorningIds.has(subId)) {
          morningDelivered.push(morningStudentData);
        } else {
          morningPending.push(morningStudentData);
        }
      }

      // 8:00 PM (DINNER) SORTING — use afternoon poll vote for mealType
      if (allowedSessions.includes('afternoon') && skippedTime !== 'afternoon' && skippedTime !== 'full_day') {
        const afternoonStudentData = { ...baseStudentData, mealType: afternoonMealType, mealSlot: 'afternoon' };
        if (deliveredAfternoonIds.has(subId)) {
          afternoonDelivered.push(afternoonStudentData);
        } else {
          afternoonPending.push(afternoonStudentData);
        }
      }
    });

    // Helper to group by hostel
    const groupStudentsByLocation = (studentsArray) => {
      return studentsArray.reduce((acc, student) => {
        const loc = student.location;
        if (!acc[loc]) acc[loc] = [];
        acc[loc].push(student);
        return acc;
      }, {});
    };

    // 🥑 6. Fetch accepted Trial Orders for today (shown as Express Dispatch)
    let extraOrders = [];
    try {
      const todayTrials = await TrialOrder.find({
        vendor: vendorProfile._id,
        targetDate: todayString,
        status: 'accepted',
      }).populate('customer', 'name phone location roomNumber');

      extraOrders = todayTrials.map((t) => ({
        trialOrderId: t._id,
        customerName: t.customer?.name || 'Unknown',
        phone: t.customer?.phone || '',
        location: t.customer?.location || 'N/A',
        roomNumber: t.customer?.roomNumber || '',
        targetSession: t.targetSession,
        price: t.price,
        isTrial: true,
      }));
    } catch (trialErr) {
      console.error('Trial order fetch error (non-fatal):', trialErr);
    }

    // 5. Send the final cleaned data to your Flutter App
    res.status(200).json({
      totalDeliveries: morningPending.length + afternoonPending.length,
      currentSession: new Date().getHours() < 15 ? 'morning' : 'afternoon',
      todaysLeavesList: studentsOnLeaveToday,
      sessions: {
        morning: {
          totalDeliveries: morningPending.length,
          groupedList: groupStudentsByLocation(morningPending)
        },
        afternoon: {
          totalDeliveries: afternoonPending.length,
          groupedList: groupStudentsByLocation(afternoonPending)
        }
      },
      deliveredSessions: {
        morning: { totalDeliveries: morningDelivered.length, groupedList: groupStudentsByLocation(morningDelivered) },
        afternoon: { totalDeliveries: afternoonDelivered.length, groupedList: groupStudentsByLocation(afternoonDelivered) }
      },
      isVendorHoliday: false,
      holidayReason: '',
      extraOrders
    });

  } catch (error) {
    console.error("Error fetching deliveries:", error);
    res.status(500).json({ message: 'Server error fetching deliveries.' });
  }
};
exports.extendPaymentDeadline = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { extraDays } = req.body; // e.g., Vendor gives 5 more days

    if (!extraDays || isNaN(extraDays)) {
      return res.status(400).json({ message: 'Please provide a valid number of days to extend.' });
    }

    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) {
      return res.status(404).json({ message: 'Subscription not found.' });
    }

    // Add the extra days to the CURRENT deadline
    const currentDeadline = new Date(subscription.paymentDeadline || Date.now());
    currentDeadline.setDate(currentDeadline.getDate() + Number(extraDays));
    
    subscription.paymentDeadline = currentDeadline;
    subscription.dueDateExtended = true; // Flag it so you know they asked for an extension!

    await subscription.save();

    res.status(200).json({ 
      message: `Deadline extended by ${extraDays} days!`,
      newDeadline: subscription.paymentDeadline
    });

  } catch (error) {
    console.error("Error extending deadline:", error);
    res.status(500).json({ message: 'Server error while extending deadline.' });
  }
};
// 🚨 FETCH THE DIGITAL KHATA (LEDGER) 🚨
exports.getLedger = async (req, res) => {
  try {
    // Find the vendor profile using the logged-in user's ID
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Kitchen not found' });

    // Fetch all subscriptions EXCEPT 'pending' ones (those belong in the Requests tab)
    const ledger = await Subscription.find({
      vendor: vendorProfile._id,
      status: { $ne: 'pending' } 
    })
    .populate('customer', 'name phone') // Get the student's name and phone number
    .sort({ updatedAt: -1 }); // Put the most recently updated ones at the top

    res.status(200).json(ledger);
  } catch (error) {
    console.error("Error fetching ledger:", error);
    res.status(500).json({ message: 'Server error fetching ledger.' });
  }
};

// 🚨 MARK PAYMENT AS RECEIVED 🚨
exports.markSubscriptionPaid = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    
    const subscription = await Subscription.findById(subscriptionId);
    if (!subscription) {
      return res.status(404).json({ message: 'Subscription not found.' });
    }

    // Flip the status to paid!
    subscription.paymentStatus = 'paid';
    await subscription.save();

    res.status(200).json({ 
      message: 'Payment marked as received!', 
      subscription 
    });
  } catch (error) {
    console.error("Error marking payment paid:", error);
    res.status(500).json({ message: 'Server error while updating payment status.' });
  }
};
// GET /api/vendor/profile/full
exports.getFullProfile = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    // 1. Get basic account details
    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // 2. Get the Kitchen Settings (Checking multiple possible field names just in case)
    let profile = await VendorProfile.findOne({ 
      $or: [{ vendorId: userId }, { vendor: userId }, { _id: userId }] 
    });
    
    // Safety net
    if (!profile) {
      profile = await VendorProfile.create({ vendorId: userId, businessName: user.name + "'s Kitchen", phone: user.phone || '' });
    }

    // 🚨 THE FIX: Search for reviews attached to EITHER the User ID OR the Profile ID!
    const reviews = await Review.find({ 
      $or: [{ vendorId: userId }, { vendorId: profile._id }] 
    })
      .populate('customerId', 'name location roomNumber')
      .sort({ createdAt: -1 });

    res.status(200).json({
      user: user,
      profile: profile,
      reviews: reviews
    });

  } catch (error) {
    console.error("Error fetching full profile:", error);
    res.status(500).json({ message: 'Server error fetching full profile.' });
  }
};
// POST /api/vendor/customers/:customerId/pay
exports.recordPayment = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found.' });
    }

    const { customerId } = req.params;
    const { amount, paymentMethod } = req.body;
    let paymentAmount = Number(amount);

    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(400).json({ message: 'Please enter a valid payment amount.' });
    }

    // 1. Fetch all unpaid or partially paid subscriptions for this customer at THIS kitchen
    const activeBills = await Subscription.find({
      vendor: vendorProfile._id,
      customer: customerId,
      paymentStatus: { $in: ['unpaid', 'partial'] }
    }).sort({ startDate: 1, createdAt: 1 });

    let remainingAmount = paymentAmount;
    const vendorName = vendorProfile.businessName || 'Kitchen';
    const createdTransactions = [];

    // 2. THE WATERFALL ENGINE — record payment for each plan separately
    for (let sub of activeBills) {
      if (remainingAmount <= 0) break;

      const totalRequired = sub.totalBill || 0;
      const alreadyPaid = sub.amountPaid || 0;
      const amountDue = totalRequired - alreadyPaid;
      if (amountDue <= 0) continue;

      const amountApplied = Math.min(remainingAmount, amountDue);
      const newPaid = alreadyPaid + amountApplied;
      sub.amountPaid = newPaid;
      sub.paymentStatus = newPaid >= totalRequired ? 'paid' : 'partial';
      await sub.save();

      const formattedPlanName = String(sub.planType || 'Plan').replaceAll('_', ' ').toUpperCase();
      const note = sub.paymentStatus === 'paid'
        ? `✅ Full Payment Completed for ${formattedPlanName}`
        : `⏳ Partial Payment for ${formattedPlanName} (Remaining: ₹${totalRequired - newPaid})`;

      const txn = await Transaction.create({
        vendorId: userId,
        customerId,
        subscription: sub._id,
        planType: formattedPlanName,
        amount: amountApplied,
        paymentMethod: paymentMethod || 'cash',
        vendorName,
        note,
        date: new Date()
      });

      createdTransactions.push(txn);
      remainingAmount -= amountApplied;
    }

    if (remainingAmount > 0) {
      const overpaymentTxn = await Transaction.create({
        vendorId: userId,
        customerId,
        amount: remainingAmount,
        paymentMethod: paymentMethod || 'cash',
        vendorName,
        planType: 'UNASSIGNED',
        note: `🔹 Overpayment credit of ₹${remainingAmount} not assigned to any active plan yet.`,
        date: new Date()
      });
      createdTransactions.push(overpaymentTxn);
    }

    if (createdTransactions.length === 0) {
      const txn = await Transaction.create({
        vendorId: userId,
        customerId,
        amount: paymentAmount,
        paymentMethod: paymentMethod || 'cash',
        vendorName,
        planType: 'UNASSIGNED',
        note: `🔹 Payment of ₹${paymentAmount} received but no unpaid plan was available.`,
        date: new Date()
      });
      createdTransactions.push(txn);
    }

    res.status(200).json({
      message: 'Payment recorded successfully!',
      leftoverCredit: remainingAmount > 0 ? remainingAmount : 0,
      transactions: createdTransactions
    });
  } catch (error) {
    console.error('Error recording payment:', error);
    res.status(500).json({ message: 'Server error processing payment.' });
  }
};

exports.getCustomerTransactions = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor profile not found.' });
    }

    const { customerId } = req.params;
    const transactions = await Transaction.find({
      vendorId: userId,
      customerId
    }).sort({ createdAt: -1 });

    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error fetching customer transactions:', error);
    res.status(500).json({ message: 'Server error fetching transactions.' });
  }
};
// PUT /api/vendor/subscriptions/:id/cancel
exports.cancelSubscription = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const subId = req.params.id;

    const vendorProfile = await VendorProfile.findOne({ vendorId: userId });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor profile not found.' });

    const sub = await Subscription.findOne({ _id: subId, vendor: vendorProfile._id });
    if (!sub) return res.status(404).json({ message: 'Subscription not found for this vendor.' });

    if (sub.status === 'cancelled' || sub.status === 'completed') {
      return res.status(400).json({ message: 'This plan is already closed.' });
    }

    // If still pending (never activated), treat like a rejection — zero the bill
    if (sub.status === 'pending') {
      sub.status = 'cancelled';
      sub.totalBill = 0;
      sub.paymentStatus = 'paid'; // A 0 bill means nothing is owed
      await sub.save();
      return res.status(200).json({ message: 'Pending plan cancelled. No charge applied.', newTotal: 0 });
    }

    // 1. DETERMINE PLAN DETAILS (Duration, Meals/Day, Price)
    const originalPrice = Number(sub.totalBill) || 0;
    const planStr = String(sub.planType || '').toLowerCase().trim();
    const originalSession = String(sub.preferredSession || '').toLowerCase().trim();

    let baseDuration = 30;
    let mealsPerDay = (planStr.includes('full') || planStr.includes('2') || originalSession === 'both') ? 2 : 1;

    // Fetch from Custom Plans if available
    if (vendorProfile.customPlans && Array.isArray(vendorProfile.customPlans)) {
      const matchedPlan = vendorProfile.customPlans.find(p =>
        String(p.planName || '').toLowerCase().trim() === planStr ||
        String(p.planName || '').toLowerCase().replace(/\s+/g, '_') === planStr
      );

      if (matchedPlan) {
        if (matchedPlan.durationDays) baseDuration = Number(matchedPlan.durationDays);
        if (matchedPlan.mealsPerDay) mealsPerDay = Number(matchedPlan.mealsPerDay);
      } else if (sub.startDate && sub.endDate) {
        // Fallback: Calculate intended duration using original dates
        const sDate = new Date(sub.startDate).setHours(0, 0, 0, 0);
        const eDate = new Date(sub.endDate).setHours(0, 0, 0, 0);
        const diffDays = Math.round((eDate - sDate) / (1000 * 60 * 60 * 24)) + 1;
        if (diffDays > 0) baseDuration = diffDays;
      }
    }

    // 2. PER-TIFFIN MATH
    const totalTiffinsInPlan = baseDuration * mealsPerDay;
    const pricePerTiffin = originalPrice / totalTiffinsInPlan;

    // 3. EFFECTIVE CANCEL DATE
    let effectiveCancelDate = new Date();
    if (sub.status === 'paused' && sub.pausedAt) {
      effectiveCancelDate = new Date(sub.pausedAt); // Stop the clock when it was paused
    }
    effectiveCancelDate.setHours(0, 0, 0, 0);

    const startDate = new Date(sub.startDate || sub.createdAt);
    startDate.setHours(0, 0, 0, 0);

    let tiffinsEaten = 0;

    if (effectiveCancelDate >= startDate) {
      const calendarDays = Math.round((effectiveCancelDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      const expectedTiffins = calendarDays * mealsPerDay;

      let skippedTiffins = 0;
      if (Array.isArray(sub.skippedDates)) {
        sub.skippedDates.forEach(entry => {
          if (!entry || !entry.date) return;
          // Safely parse date regardless of timezone
          const [y, m, d] = entry.date.split('-').map(Number);
          const targetDate = new Date(y, m - 1, d, 0, 0, 0, 0);

          // Only count leaves taken up to the cancellation date
          if (targetDate.getTime() <= effectiveCancelDate.getTime()) {
            const timeVal = entry.time || 'full_day';
            if (timeVal === 'full_day') {
              skippedTiffins += mealsPerDay; // Skips all meals for that day
            } else {
              skippedTiffins += 1; // Skips just 1 meal
            }
          }
        });
      }

      tiffinsEaten = expectedTiffins - skippedTiffins;
      if (tiffinsEaten < 0) tiffinsEaten = 0;
    }

    // Cap tiffins eaten to max plan tiffins to avoid overcharging
    if (tiffinsEaten > totalTiffinsInPlan) tiffinsEaten = totalTiffinsInPlan;

    // 4. FINAL BILL
    let finalBill = Math.round(tiffinsEaten * pricePerTiffin);
    if (finalBill > originalPrice) finalBill = originalPrice;

    // 5. UPDATE AND SAVE
    sub.totalBill = finalBill;
    sub.status = 'cancelled';
    sub.endDate = effectiveCancelDate;

    const amountPaid = Number(sub.amountPaid) || 0;
    if (amountPaid >= finalBill) {
      sub.paymentStatus = 'paid';
    } else if (amountPaid > 0) {
      sub.paymentStatus = 'partial';
    } else {
      sub.paymentStatus = 'unpaid';
    }

    await sub.save();

    res.status(200).json({
      message: `Plan cancelled. Billed for ${tiffinsEaten} tiffins: ₹${finalBill}`,
      newTotal: finalBill
    });

  } catch (error) {
    console.error("Error cancelling subscription:", error);
    res.status(500).json({ message: 'Server error cancelling plan.' });
  }
};

// POST /api/vendor/subscriptions/:id/pay
exports.paySubscriptionBill = async (req, res) => {
  try {
    const { id } = req.params; // This is the Subscription ID!
    const { amount, paymentMethod } = req.body;
    const paymentAmount = Number(amount);

    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(400).json({ message: 'Valid payment amount is required' });
    }

    const subscription = await Subscription.findById(id).populate('customer vendor');
    if (!subscription) return res.status(404).json({ message: 'Subscription plan not found' });

    // 1. Update the Subscription's Math
    subscription.amountPaid = (subscription.amountPaid || 0) + paymentAmount;
    
    // 🚨 THE SMART NARRATIVE NOTE ENGINE 🚨
    let paymentNarrative = '';
    const formattedPlanName = (subscription.planType || 'Plan').replace('_', ' ').toUpperCase();

    // Determine the new status and write the note
    if (subscription.amountPaid >= subscription.totalBill) {
      subscription.paymentStatus = 'paid';
      paymentNarrative = `✅ Full Payment Completed for ${formattedPlanName}`;
    } else {
      subscription.paymentStatus = 'partial';
      paymentNarrative = `⏳ Partial Payment for ${formattedPlanName} (Remaining: ₹${subscription.totalBill - subscription.amountPaid})`;
    }

    await subscription.save();

    // 2. Save the perfectly formatted, Plan-Wise Transaction History!
    const transaction = await Transaction.create({
      customer: subscription.customer._id,
      vendor: subscription.vendor._id,
      subscription: subscription._id, // Tied directly to the plan
      amount: paymentAmount,
      paymentMethod: paymentMethod || 'cash',
      vendorName: subscription.vendor.businessName,
      planType: formattedPlanName,
      note: paymentNarrative, // <--- Saves the exact sentence perfectly
      date: new Date()
    });

    res.status(200).json({ message: 'Plan payment recorded successfully', subscription, transaction });
  } catch (error) {
    console.error("Error processing plan payment:", error);
    res.status(500).json({ message: 'Server error processing payment' });
  }
};
// --- Edit Announcement ---
exports.editAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, type } = req.body;
    
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found' });

    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'Announcement text cannot be empty.' });
    }

    const updatedAnnouncement = await Announcement.findOneAndUpdate(
      { _id: id, vendor: vendorProfile._id }, // Ensure they only edit THEIR own announcement
      { text: String(text).trim(), type: type || 'General' },
      { new: true }
    );

    if (!updatedAnnouncement) {
      return res.status(404).json({ message: 'Announcement not found.' });
    }

    res.status(200).json({ message: 'Announcement updated successfully!', announcement: updatedAnnouncement });
  } catch (error) {
    console.error("Error updating announcement:", error);
    res.status(500).json({ message: 'Server error updating announcement' });
  }
};

exports.deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found' });

    const deletedAnnouncement = await Announcement.findOneAndDelete({ 
      _id: id, 
      vendor: vendorProfile._id // Ensure they only delete THEIR own announcement
    });

    if (!deletedAnnouncement) {
      return res.status(404).json({ message: 'Announcement not found.' });
    }

    res.status(200).json({ message: 'Announcement deleted successfully!' });
  } catch (error) {
    console.error("Error deleting announcement:", error);
    res.status(500).json({ message: 'Server error deleting announcement' });
  }
};

// --- 🔒 Toggle Poll Lock (Open / Close voting) ---
exports.togglePollLock = async (req, res) => {
  try {
    const { id } = req.params;

    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found' });

    const announcement = await Announcement.findOne({ _id: id, vendor: vendorProfile._id });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found.' });

    if (announcement.type !== 'Poll') {
      return res.status(400).json({ message: 'Only polls can be locked or unlocked.' });
    }

    // Flip the isClosed flag
    announcement.isClosed = !announcement.isClosed;
    await announcement.save();

    const statusLabel = announcement.isClosed ? 'locked' : 'unlocked';
    res.status(200).json({
      message: `Poll ${statusLabel} successfully!`,
      isClosed: announcement.isClosed,
    });
  } catch (error) {
    console.error('Error toggling poll lock:', error);
    res.status(500).json({ message: 'Server error toggling poll lock' });
  }
};

// --- 👥 Get Voters for a specific poll option ---
exports.getPollVoters = async (req, res) => {
  try {
    const { id, optionIndex } = req.params;
    
    // Populate the voters with name, roomNumber, location, and phone
    const announcement = await Announcement.findById(id).populate('options.voters', 'name roomNumber location phone');
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found.' });
    }

    // Explicitly allow BOTH standard Polls and Meal Selection polls
    if (announcement.type !== 'Poll' && announcement.type !== 'Meal Selection' && announcement.isMealSelection !== true) {
      return res.status(400).json({ message: 'Not a poll type that supports voters.' });
    }

    const option = announcement.options[optionIndex];
    if (!option) {
      return res.status(404).json({ message: 'Option not found.' });
    }

    res.status(200).json(option.voters);
  } catch (error) {
    console.error('Error fetching poll voters:', error);
    res.status(500).json({ message: 'Server error fetching voters.' });
  }
};

// =============================================================================
// TRIAL TIFFIN MANAGEMENT (VENDOR SIDE)
// =============================================================================

// GET /vendor/trials — list pending trial orders for the authenticated vendor
exports.getTrialOrders = async (req, res) => {
  try {
    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found' });

    const trials = await TrialOrder.find({ vendor: vendorProfile._id })
      .populate('customer', 'name phone location roomNumber')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.status(200).json(trials);
  } catch (error) {
    console.error('Error fetching trial orders:', error);
    res.status(500).json({ message: 'Server error fetching trial orders.' });
  }
};

// PUT /vendor/trials/:id/respond — accept or decline a trial order
exports.respondToTrialOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'accept' | 'decline'

    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ message: 'action must be "accept" or "decline".' });
    }

    const vendorProfile = await VendorProfile.findOne({ vendorId: req.user.userId || req.user.id });
    if (!vendorProfile) return res.status(404).json({ message: 'Vendor not found' });

    const trial = await TrialOrder.findOne({ _id: id, vendor: vendorProfile._id });
    if (!trial) return res.status(404).json({ message: 'Trial order not found.' });

    trial.status = action === 'accept' ? 'accepted' : 'declined';
    await trial.save();

    // Fire a push notification to the student (best-effort)
    try {
      const studentUser = await User.findById(trial.customer, 'fcmToken name').lean();
      if (studentUser?.fcmToken) {
        const statusText = action === 'accept' ? 'accepted ✅' : 'declined ❌';
        await sendPushNotification(
          studentUser.fcmToken,
          `Trial Tiffin ${statusText}`,
          `${vendorProfile.businessName} has ${action === 'accept' ? 'accepted' : 'declined'} your trial tiffin request.`,
        );
      }
    } catch (notifErr) {
      console.error('Trial notification error (non-fatal):', notifErr);
    }

    res.status(200).json({ message: `Trial order ${trial.status}.`, trial });
  } catch (error) {
    console.error('Error responding to trial order:', error);
    res.status(500).json({ message: 'Server error responding to trial order.' });
  }
};
