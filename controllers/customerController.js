const mongoose = require('mongoose');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const DailyMenu = require('../models/DailyMenu');
const { normalizeDateKey, getTodayMenuDateInfo, IST_TIME_ZONE } = require('../utils/dailyMenuDateKey');
const Announcement = require('../models/Announcement');

const VendorHoliday = require('../models/VendorHoliday');

const HomemadeItem = require('../models/HomemadeItem');
const HomemadeOrder = require('../models/HomemadeOrder');
const HomemadeStockLog = require('../models/HomemadeStockLog');
const Review = require('../models/Review');
const Transaction = require('../models/Transaction');
const VendorProfile = require('../models/VendorProfile');
const TrialOrder = require('../models/TrialOrder');
const { sendPushNotification } = require('./notificationController');


const parseDateKeyAsLocal = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
};

const normalizeSessionValue = (value) => {
  if (!value) return '';
  const normalized = String(value).trim().toLowerCase();
  if (['morning', 'lunch'].includes(normalized)) return 'morning';
  if (['afternoon', 'evening', 'dinner'].includes(normalized)) return 'afternoon';
  if (normalized === 'both') return 'both';
  return normalized;
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

  if (!lunchItems && !dinnerItems) return null;

  return {
    day: dayName,
    lunch: { time: '12:30 PM', items: lunchItems || 'No lunch menu set.' },
    dinner: dinnerItems ? { time: '8:00 PM', items: dinnerItems } : null
  };
};

const getPlanDurationDays = (planType) => {
  const type = String(planType || '').toLowerCase();
  if (type.includes('single')) return 1;
  if (type.includes('weekly') || type.includes('7_days')) return 7;
  if (type.includes('15_days')) return 15;
  return 30; // Default monthly duration
};

const getPlanSessionCount = (planType) => {
  const type = String(planType || '').toLowerCase();
  if (type.includes('full')) return 2;
  return 1;
};

const countSkippedTiffins = (skippedDates = [], until = new Date()) => {
  if (!Array.isArray(skippedDates)) return 0;
  return skippedDates.reduce((count, entry) => {
    if (!entry) return count;
    const dateString = entry.date || entry;
    const time = entry.time || 'full_day';
    const targetDate = parseDateKeyAsLocal(String(dateString));
    if (!targetDate || targetDate.getTime() > until.getTime()) return count;
    if (time === 'full_day') return count + 2;
    if (time === 'morning' || time === 'afternoon') return count + 1;
    return count + 1;
  }, 0);
};

const getTotalTiffins = (planType) => getPlanDurationDays(planType) * getPlanSessionCount(planType);

const defaultWeeklyMenu = () => ({
  Monday: { lunch: '', dinner: '' },
  Tuesday: { lunch: '', dinner: '' },
  Wednesday: { lunch: '', dinner: '' },
  Thursday: { lunch: '', dinner: '' },
  Friday: { lunch: '', dinner: '' },
  Saturday: { lunch: '', dinner: '' },
  Sunday: { lunch: '', dinner: '' }
});

const recomputeVendorRating = async (vendorId) => {
  const vendorProfile = await VendorProfile.findOne({
    $or: [{ vendorId: vendorId }, { _id: vendorId }]
  });
  if (!vendorProfile) return;

  const allReviews = await Review.find({
    $or: [
      { vendor: vendorProfile._id }, 
      { vendor: vendorProfile.vendorId },
      { vendorId: vendorProfile._id }, 
      { vendorId: vendorProfile.vendorId }
    ]
  });

  const totalReviews = allReviews.length;
  const sumRatings = allReviews.reduce((sum, rev) => sum + (Number(rev.rating) || 0), 0);
  const averageRating = totalReviews > 0 ? Number((sumRatings / totalReviews).toFixed(1)) : 0;

  vendorProfile.rating = averageRating;
  vendorProfile.totalReviews = totalReviews;
  await vendorProfile.save();
  return { averageRating, totalReviews };
};

exports.getDailyDeliveryList = async (req, res) => {
  try {
    const vendorId = req.vendor.id; // From your auth middleware
    
    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const todayDateString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Normalize today for date comparisons
    const menuDateInfo = getTodayMenuDateInfo();
    const todayMidnight = menuDateInfo.start;

    // 1. Fetch all ACTIVE subscriptions for this vendor
    const allActiveSubs = await Subscription.find({ 
      vendorId: vendorId, 
      status: 'active' 
    }).populate('customerId', 'name phone location roomNumber');

    // 2. 🚨 THE FIX: The Time-Aware Filter 🚨
    const deliveriesToday = allActiveSubs.filter(sub => {
      // Rule A: Has the plan actually started yet?
      if (sub.startDate) {
        const start = new Date(sub.startDate);
        start.setHours(0, 0, 0, 0);
        if (start > todayMidnight) return false; // FUTURE PLAN: Ignore!
      }

      // Rule B: Has the plan already expired?
      if (sub.endDate) {
        const end = new Date(sub.endDate);
        end.setHours(0, 0, 0, 0);
        if (end < todayMidnight) return false; // EXPIRED PLAN: Ignore!
      }

      // Rule C: Did they mark a holiday for today?
      if (!sub.skippedDates || !Array.isArray(sub.skippedDates)) return true;
      return !sub.skippedDates.some(entry => entry?.date === todayDateString);
    });

    // 3. Smart Grouping
    const groupedDeliveries = deliveriesToday.reduce((acc, sub) => {
      if (!sub.customerId) return acc; 

      const location = sub.customerId.location || 'Unspecified Location';
      
      if (!acc[location]) {
        acc[location] = [];
      }
      
      acc[location].push({
        subscriptionId: sub._id,
        customerName: sub.customerId.name,
        roomNumber: sub.customerId.roomNumber || 'N/A',
        phone: sub.customerId.phone,
        planType: sub.planType,
        mealType: sub.mealType
      });
      
      return acc;
    }, {});

    res.status(200).json({ 
      date: todayDateString,
      totalDeliveries: deliveriesToday.length,
      groupedList: groupedDeliveries 
    });

  } catch (error) {
    console.error("Error fetching delivery list:", error);
    res.status(500).json({ error: "Server error fetching delivery list" });
  }
};
// GET PROFILE
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password'); 
    if (!user) return res.status(404).json({ error: "User not found" });
    
    res.status(200).json(user);
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ error: "Server error fetching profile" });
  }
};

// UPDATE PROFILE
exports.updateProfile = async (req, res) => {
  try {
    // Extracting exactly what matches your schema
    const { name, phone, location, roomNumber } = req.body;

    const updatedUser = await User.findByIdAndUpdate(
      req.user.userId,
      { name, phone, location, roomNumber },
      { new: true, runValidators: true }
    ).select('-password');

    if (!updatedUser) return res.status(404).json({ error: "User not found" });

    res.status(200).json({ message: "Profile updated successfully", user: updatedUser });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ error: "Server error updating profile" });
  }
};
exports.updateHolidays = async (req, res) => {
  try {
    const subscriptionId = req.params.id;
    const customerId = req.user.userId || req.user.id;
    const { skippedDates } = req.body;

    if (!Array.isArray(skippedDates)) {
      return res.status(400).json({ error: "skippedDates must be an array." });
    }

    const subscription = await Subscription.findOne({
      _id: subscriptionId,
      customer: customerId
    });

    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found for this customer." });
    }

    // 🚨 1. TWO-TIER HOLIDAY LOGIC FUNCTION 🚨
    const determineIfConsidered = (time) => {
      const normalizedTime = normalizeSessionValue(time);
      const normalizedSession = normalizeSessionValue(subscription.preferredSession || subscription.mealType);

      const isLunchOnlyPlan = normalizedSession === 'morning';
      const isDinnerOnlyPlan = normalizedSession === 'afternoon';
      const isFullDayEquivalent =
        normalizedTime === 'full_day' ||
        (isLunchOnlyPlan && normalizedTime === 'morning') ||
        (isDinnerOnlyPlan && normalizedTime === 'afternoon');

      return subscription.vendorConsidersHolidays === true && isFullDayEquivalent;
    };

    // Normalize incoming data and apply the Two-Tier Logic
    const normalizedHolidays = skippedDates.map(holiday => {
      if (typeof holiday === 'string') {
        return { 
          date: normalizeDateKey(holiday), 
          time: 'full_day',
          isConsideredForExtension: determineIfConsidered('full_day')
        };
      } else if (typeof holiday === 'object' && holiday.date) {
        const timeVal = holiday.time || 'full_day';
        return {
          date: normalizeDateKey(holiday.date),
          time: timeVal,
          isConsideredForExtension: determineIfConsidered(timeVal)
        };
      }
      return null;
    }).filter(Boolean);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const mergedHolidays = new Map();
    const holidayKey = (h) => `${h.date}`;

    const existingHolidays = Array.isArray(subscription.skippedDates)
      ? subscription.skippedDates.filter(Boolean)
      : [];

    // KEEP HISTORY (Past holidays)
    existingHolidays.forEach((holiday) => {
      if (!holiday || !holiday.date) return;
      const hDate = parseDateKeyAsLocal(holiday.date);
      if (hDate.getTime() < tomorrowStart.getTime()) {
        mergedHolidays.set(holidayKey(holiday), holiday); // Keep exactly as they were
      }
    });

    // OVERWRITE FUTURE with new validated array
    // 🚨 BUG 1 FIX: Compute the plan's endDate boundary for the upper-bound guard
    const planEndBoundary = subscription.endDate ? new Date(subscription.endDate) : null;
    if (planEndBoundary) planEndBoundary.setHours(23, 59, 59, 999);

    const ignoredDates = [];
    normalizedHolidays.forEach((holiday) => {
      if (!holiday || !holiday.date) return;
      const targetDate = parseDateKeyAsLocal(holiday.date);

      // Lower bound: must be tomorrow or later (no retroactive edits)
      if (targetDate.getTime() < tomorrowStart.getTime()) {
        ignoredDates.push(holiday.date);
        return;
      }

      // Upper bound: must not exceed the plan's own endDate
      if (planEndBoundary && targetDate.getTime() > planEndBoundary.getTime()) {
        ignoredDates.push(holiday.date);
        return;
      }

      mergedHolidays.set(holidayKey(holiday), holiday);
    });

    // Save the synced list!
    subscription.skippedDates = Array.from(mergedHolidays.values());

    // 🔑 SORT FIX: The frontend may send dates in any order, and Map preserves
    // insertion order — so sort the merged array chronologically NOW, before the
    // consecutive chunking loop runs. Without this, out-of-order input (e.g.
    // Aug 13 before Aug 5) creates false group breaks and grants 0 extensions.
    // This also ensures the final array saved to MongoDB is cleanly ordered for the UI.
    subscription.skippedDates.sort((a, b) => new Date(a.date) - new Date(b.date));

    // 🚨 2. APPLY minimumHolidayDays CONSECUTIVE-DAY RULE 🚨

    // Fetch vendor profile to read the threshold (default 1 = every single day counts)
    const vendorProfile = await VendorProfile.findOne({ vendorId: subscription.vendor });
    const minimumHolidayDays = (vendorProfile?.minimumHolidayDays) || 1;

    // Collect only dates that are full-day-equivalent for this plan (reuses existing helper)
    // subscription.skippedDates is already sorted above; .sort() here is a safety-net only.
    const fullDayCandidateDates = subscription.skippedDates
      .filter(h => determineIfConsidered(h.time))
      .map(h => h.date)
      .sort(); // YYYY-MM-DD lexicographic sort is chronological


    // Group the candidate dates into consecutive runs
    const consecutiveGroups = [];
    let currentGroup = [];
    for (const dateKey of fullDayCandidateDates) {
      if (currentGroup.length === 0) {
        currentGroup.push(dateKey);
      } else {
        const prev = parseDateKeyAsLocal(currentGroup[currentGroup.length - 1]);
        const curr = parseDateKeyAsLocal(dateKey);
        const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          currentGroup.push(dateKey);
        } else {
          consecutiveGroups.push(currentGroup);
          currentGroup = [dateKey];
        }
      }
    }
    if (currentGroup.length > 0) consecutiveGroups.push(currentGroup);

    // Only groups that meet the minimum threshold qualify for plan extension
    const qualifyingDates = new Set();
    for (const group of consecutiveGroups) {
      if (group.length >= minimumHolidayDays) {
        group.forEach(d => qualifyingDates.add(d));
      }
    }

    // Stamp isConsideredForExtension on every entry in the merged list
    // 🚨 BUG 2 FIX: Mongoose subdocuments must be converted to plain objects before
    // spreading — otherwise the spread is a no-op and isConsideredForExtension is
    // silently dropped, leaving the flag from the initial normalizedHolidays pass.
    // Single-meal skips are never in qualifyingDates so they remain false automatically.
    subscription.skippedDates = subscription.skippedDates.map(h => ({
      ...(h.toObject ? h.toObject() : h),
      isConsideredForExtension: qualifyingDates.has(h.date)
    }));

// 🚨 3. RECALCULATE THE END DATE 🚨
    const consideredDaysCount = subscription.skippedDates.filter(h => h.isConsideredForExtension).length;
    
    // FETCH THE PROTECTED VENDOR EXTENSIONS!
    const vendorExtDays = subscription.vendorExtensionDays || 0; 
    
    const baseDuration = getPlanDurationDays(subscription.planType);
    
    // 🚨 THE FIX 1: Capture the old date BEFORE we change it!
    const oldEndDate = subscription.endDate ? new Date(subscription.endDate) : null;
    
    const newEndDate = new Date(subscription.startDate);
    
    // Add base duration + student holidays + vendor emergencies
    newEndDate.setDate(newEndDate.getDate() + (baseDuration - 1) + consideredDaysCount + vendorExtDays);
    
    subscription.endDate = newEndDate;
    const updatedSubscription = await subscription.save();

    // 🚨 THE FIX 2: Shift the upcoming "Sleeping Giants"
    try {
      if (oldEndDate && updatedSubscription.endDate) {
        const deltaMs = updatedSubscription.endDate.getTime() - oldEndDate.getTime();
        
        // If the end date moved forward OR backward, we must shift the future plans!
        if (deltaMs !== 0) {
          // Use Math.round to avoid Daylight Savings Time bugs
          const deltaDays = Math.round(deltaMs / (1000 * 60 * 60 * 24));

    // Find future subscriptions that start after the old plan ended
          // Subtract 1 minute just to be safe with database time precision
          const searchDate = new Date(oldEndDate.getTime() - 60000); 

          const futureSubs = await Subscription.find({
            customer: customerId,
            vendor: subscription.vendor,
            // 🚨 THE FIX: Strictly match the plan type and session!
            planType: subscription.planType,
            preferredSession: subscription.preferredSession,
            startDate: { $gt: searchDate }
          });

          // Shift the start AND end date of every queued matching plan!
          for (const f of futureSubs) {
            f.startDate = new Date(f.startDate.getTime() + deltaDays * 24 * 60 * 60 * 1000);
            if (f.endDate) f.endDate = new Date(f.endDate.getTime() + deltaDays * 24 * 60 * 60 * 1000);
            await f.save();
          }
        }
      }
    } catch (err) {
      console.error('Error shifting future subscriptions after holiday update', err);
    }

    res.status(200).json({
      message: 'Holidays updated successfully.',
      subscription: updatedSubscription,
      ignoredDates
    });
  } catch (error) {
    console.error('Error updating holidays:', error);
    res.status(500).json({ error: 'Server error updating holiday plan' });
  }
};
exports.getSubscriptionById = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const subscriptionId = req.params.id;

    const subscription = await Subscription.findOne({
      _id: subscriptionId,
      customer: customerId
    }).populate('vendor', 'businessName');

    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found for this customer." });
    }

    res.status(200).json(subscription);
  } catch (error) {
    console.error("Error fetching subscription:", error);
    res.status(500).json({ error: "Server error fetching subscription" });
  }
};

exports.getCustomerDashboard = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    const menuDateInfo = getTodayMenuDateInfo();
    const todayMidnight = menuDateInfo.start;

    const rawSubscriptions = await Subscription.find({ customer: customerId }).lean();

    const allSubscriptions = await Promise.all(
      rawSubscriptions.map(async (sub) => {
        if (!sub.vendor) return sub;
        const vendorProfile = await VendorProfile.findOne({
          $or: [{ _id: sub.vendor }, { vendorId: sub.vendor }]
        }).select('businessName ownerName weeklyMenu vendorId').lean();

        return {
          ...sub,
          vendor: vendorProfile || null,
        };
      })
    );

    const activeSubscriptions = allSubscriptions.filter((sub) => {
      const statusMatch = String(sub.status || '').trim().toLowerCase() === 'active';
      const endsInFuture = sub.endDate ? new Date(sub.endDate) >= todayMidnight : true;

      const tomorrowMidnight = new Date(todayMidnight);
      tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
      const startedAlready = sub.startDate ? new Date(sub.startDate) < tomorrowMidnight : true;

      return statusMatch && endsInFuture && startedAlready;
    });

    const today = new Date();
    let hasPendingBill = false;
    activeSubscriptions.forEach((sub) => {
      if (String(sub.paymentStatus || '').trim().toLowerCase() === 'unpaid' && sub.endDate) {
        if (today > new Date(sub.endDate)) {
          hasPendingBill = true;
        }
      }
    });

    let announcements = [];
    let weeklyMenus = [];

    if (activeSubscriptions.length > 0) {
      const vendorNamesMap = {};
      const activeVendorIds = [];

      activeSubscriptions.forEach((sub) => {
        if (sub.vendor && sub.vendor._id) {
          const vIdStr = String(sub.vendor._id);
          if (!vendorNamesMap[vIdStr]) {
            activeVendorIds.push(new mongoose.Types.ObjectId(vIdStr));
            vendorNamesMap[vIdStr] = sub.vendor.businessName || sub.vendor.ownerName || 'Vendor';
          }
        }
      });

      if (activeVendorIds.length > 0) {
        const rawAnnouncements = await Announcement.find({
          vendor: { $in: activeVendorIds },
        })
          .sort({ createdAt: -1 })
          .limit(10);

        announcements = rawAnnouncements.map((ann) => {
          const annObj = ann.toObject();
          const vIdStr = String(ann.vendor);
          annObj.vendorName = vendorNamesMap[vIdStr] || 'Vendor';
          return annObj;
        });
      }
    }

    weeklyMenus = activeSubscriptions
      .filter((sub) => sub.vendor)
      .map((sub) => ({
        subscriptionId: sub._id,
        vendorId: sub.vendor._id,
        vendorName: sub.vendor.businessName || 'Vendor',
        weeklyMenu: sub.vendor.weeklyMenu || defaultWeeklyMenu(),
      }));

    const subscribedVendors = Array.from(
      new Map(
        activeSubscriptions
          .filter((sub) => sub.vendor && sub.vendor._id)
          .map((sub) => [String(sub.vendor._id), sub.vendor])
      ).values()
    );
    // 🔧 BUG FIX: Cast to ObjectId so MongoDB $in query matches correctly.
    // vendor._id from a .lean() result can be a BSON ObjectId or a plain string;
    // explicitly converting eliminates silent type-mismatch failures.
    const vendorIds = subscribedVendors.map(
      (vendor) => new mongoose.Types.ObjectId(String(vendor._id))
    );

    // 📋 DIAGNOSTIC LOG 1 — verify which vendor IDs we are querying for
    console.log('[Dashboard:subscribedVendors]', {
      count: subscribedVendors.length,
      vendorIds: vendorIds.map(String),
      dateKey: menuDateInfo.dateKey,
    });

    const dailyMenus = vendorIds.length
      ? await DailyMenu.find({
          vendor: { $in: vendorIds },
          dateKey: menuDateInfo.dateKey,
        }).lean()
      : [];

    // 📋 DIAGNOSTIC LOG 2 — verify what menus MongoDB returned
    console.log('[Dashboard:fetchedMenus]', {
      queriedDateKey: menuDateInfo.dateKey,
      menuCount: dailyMenus.length,
      menus: dailyMenus.map((m) => ({
        menuId: String(m._id),
        vendorId: String(m.vendor),
        dateKey: m.dateKey,
        hasLunch: Boolean(m.lunch?.items),
        hasDinner: Boolean(m.dinner?.items),
      })),
    });

    const menusByVendorId = new Map(
      dailyMenus.map((menu) => [String(menu.vendor), menu])
    );

    const subscribedMenus = subscribedVendors.map((vendor) => {
      const menu = menusByVendorId.get(String(vendor._id));
      return {
        vendorId: String(vendor._id),
        businessName: vendor.businessName || vendor.ownerName || 'Kitchen',
        // If the vendor hasn't posted today, lunch and dinner are null — but
        // the vendor still appears in the carousel so the student sees them.
        lunch: menu?.lunch
          ? { time: menu.lunch.time || '12:30 PM', items: menu.lunch.items || '' }
          : null,
        dinner: menu?.dinner
          ? { time: menu.dinner.time || '8:00 PM', items: menu.dinner.items || '' }
          : null,
      };
    });

    const tomorrowMidnightForUpcoming = new Date(todayMidnight);
    tomorrowMidnightForUpcoming.setDate(tomorrowMidnightForUpcoming.getDate() + 1);

    const upcomingSubscriptions = await Subscription.find({
      customer: customerId,
      status: 'active',
      startDate: { $gte: tomorrowMidnightForUpcoming },
    }).populate('vendor', 'businessName ownerName weeklyMenu');

    const hasUpcomingPlan = upcomingSubscriptions.length > 0;

    res.status(200).json({
      user: await User.findById(customerId).select('name email location'),
      subscriptions: activeSubscriptions,
      subscription: activeSubscriptions.length > 0 ? activeSubscriptions[0] : null,
      hasPendingBill,
      hasUpcomingPlan,
      upcomingSubscriptions,
      subscribedMenus,
      weeklyMenus,
      announcements,
      stats: {
        activeSubscriptions: activeSubscriptions.length + upcomingSubscriptions.length,
        totalOrders: 0,
        monthlySpend: 0,
      },
    });
  } catch (error) {
    console.error('Dashboard Data Error:', error);
    res.status(500).json({ message: 'Server error fetching dashboard data' });
  }
};
exports.getAllVendors = async (req, res) => {
  try {
    // Only surface approved kitchens to customers
    const vendors = await VendorProfile.find(
      { status: 'approved' },
      {
        businessName: 1,
        ownerName: 1,
        serviceArea: 1,
        foodType: 1,
        serviceType: 1,
        deliveryType: 1,
        phone: 1,
        customPlans: 1,
        considersHolidays: 1,
        minimumHolidayDays: 1,
        rating: 1,
        totalReviews: 1,
        status: 1,
        trialPrice: 1,
      }
    );

    res.status(200).json(vendors);
  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({ message: 'Server error fetching vendors' });
  }
};


// Get a single vendor by ID
exports.getVendorById = async (req, res) => {
  try {
    // req.params.id grabs the ID directly from the URL!
    const vendor = await VendorProfile.findById(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({ message: 'Vendor not found' });
    }
    
    res.status(200).json(vendor);
  } catch (error) {
    console.error("Error fetching vendor details:", error);
    res.status(500).json({ message: 'Server error fetching vendor details' });
  }
};

exports.createSubscriptionRequest = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const { 
      vendorId, 
      planType, 
      planName, 
      planId, 
      price, 
      durationDays, 
      mealsPerDay, 
      mealType, 
      preferredSession, 
      requestedDate 
    } = req.body;

    // 1. Fetch the Vendor to get their customPlans AND holiday policy
    const vendor = await VendorProfile.findById(vendorId);
    if (!vendor) return res.status(404).json({ message: 'Kitchen not found.' });

    // 2. Search for the specific matching plan in vendor's customPlans array
    let selectedPlan = null;
    if (vendor.customPlans && Array.isArray(vendor.customPlans) && vendor.customPlans.length > 0) {
      if (planId) {
        selectedPlan = vendor.customPlans.id(planId) || vendor.customPlans.find(p => String(p._id) === String(planId));
      }
      if (!selectedPlan && planName) {
        selectedPlan = vendor.customPlans.find(p => p.planName.toLowerCase().trim() === String(planName).toLowerCase().trim());
      }
      if (!selectedPlan && planType) {
        // Match by planName exact, or normalized slug (e.g., "15_day_lunch" -> "15 Day Lunch")
        selectedPlan = vendor.customPlans.find(p => 
          p.planName.toLowerCase().replace(/\s+/g, '_') === String(planType).toLowerCase() ||
          p.planName.toLowerCase().trim() === String(planType).toLowerCase().trim()
        );
      }
    }

    // 3. Extract price and duration from custom plan or request body
    let totalBill = 0;
    let planDurationDays = 30;

    if (selectedPlan) {
      totalBill = Number(selectedPlan.price) || 0;
      planDurationDays = Number(selectedPlan.durationDays) || 30;
    } else if (price !== undefined && price !== null && Number(price) > 0) {
      // Direct price override sent from request payload
      totalBill = Number(price);
      planDurationDays = Number(durationDays) || 30;
    } else {
      // Legacy fallback logic for old fixed-price fields
      if (planType === 'monthly_half') {
        planDurationDays = 30;
        totalBill = vendor.monthlyHalfPrice || 0;
      } else if (planType === 'weekly') {
        planDurationDays = 7;
        totalBill = vendor.weeklyPrice || 0;
      } else if (planType === 'single') {
        planDurationDays = 1;
        totalBill = vendor.singleMealPrice || 0;
      } else if (planType === '15_days') {
        planDurationDays = 15;
        totalBill = vendor.weeklyPrice ? Math.round((vendor.weeklyPrice / 7) * 15) : 0;
      } else {
        planDurationDays = 30;
        totalBill = vendor.monthlyFullPrice || 0;
      }
    }

    // 4. Handle start/end date calculation
    let startDate = null;
    let endDate   = null;

    if (planType === 'single' || planDurationDays === 1) {
      // Single / trial meal: student picks an explicit date
      startDate = requestedDate ? new Date(requestedDate) : new Date();
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate); // single-day; start == end
    }

    // 5. Create the Subscription
    const newSubscription = await Subscription.create({
      customer: customerId,
      vendor: vendorId,
      planType: planName || (selectedPlan ? selectedPlan.planName : planType) || 'Custom Plan',
      mealType: mealType,
      preferredSession: preferredSession || 'both',
      startDate: startDate,
      endDate: endDate,
      vendorConsidersHolidays: vendor.considersHolidays || false,
      totalBill: totalBill,
      paymentStatus: 'unpaid',
      status: 'pending' // Vendor still needs to approve it
    });

    res.status(201).json({ message: 'Request sent to the kitchen!', subscription: newSubscription });

    // --- TRIGGER 1: Notify vendor of new subscription request (fire-and-forget) ---
    try {
      // The customer's display name for the notification body
      const customerUser = await User.findById(customerId).select('name').lean();
      const studentName = customerUser?.name ?? 'A student';

      // vendor.vendorId is the User._id of the vendor's account
      const vendorUser = await User.findById(vendor.vendorId).select('fcmToken').lean();
      if (vendorUser?.fcmToken) {
        await sendPushNotification(
          vendorUser.fcmToken,
          'New Subscription Request! 🔔',
          `${studentName} wants to join your mess.`,
        );
      }
    } catch (notifErr) {
      // Never block the response for a notification failure
      console.error('Vendor notification error (Trigger 1):', notifErr);
    }
  } catch (error) {
    console.error("Subscription Error:", error);
    res.status(500).json({ message: 'Server error creating request.' });
  }
};
// Get all subscriptions for the logged-in customer
exports.getMySubscriptions = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    // Find all subscriptions for this user and populate the vendor's business name
    const subscriptions = await Subscription.find({ customer: customerId })
      .populate('vendor', 'businessName')
      .sort({ createdAt: -1 }); // Shows the newest requests at the top!

    const vendorIds = subscriptions
      .map((sub) => sub.vendor?._id)
      .filter((id) => id);

    const vendorHolidays = await VendorHoliday.find({ vendor: { $in: vendorIds } });

    const vendorHolidayMap = vendorHolidays.reduce((acc, holiday) => {
      const vendorId = holiday.vendor.toString();
      acc[vendorId] = acc[vendorId] || [];
      acc[vendorId].push({
        dateKey: holiday.dateKey,
        time: holiday.time || 'full_day',
        reason: holiday.reason
      });
      return acc;
    }, {});

    const enriched = subscriptions.map((sub) => {
      const vendorId = sub.vendor?._id?.toString();
      const subObj = sub.toObject();
      return {
        ...subObj,
        vendorHolidays: vendorId ? vendorHolidayMap[vendorId] || [] : []
      };
    });

    res.status(200).json(enriched);
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    res.status(500).json({ message: 'Server error fetching subscriptions' });
  }
};

exports.getSubscribedWeeklyMenus = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const activeSubscriptions = await Subscription.find({
      customer: customerId,
      status: 'active'
    }).populate('vendor', 'businessName weeklyMenu');

    const menus = activeSubscriptions
      .filter((sub) => sub.vendor)
      .map((sub) => ({
        subscriptionId: sub._id,
        vendorId: sub.vendor._id,
        vendorName: sub.vendor.businessName || 'Vendor',
        weeklyMenu: sub.vendor.weeklyMenu || defaultWeeklyMenu()
      }));

    res.status(200).json({ menus });
  } catch (error) {
    console.error('Error fetching subscribed weekly menus:', error);
    res.status(500).json({ message: 'Server error fetching weekly menus' });
  }
};

// --- Get My Orders (derived from customer subscriptions) ---
exports.getMyOrders = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const subscriptions = await Subscription.find({ customer: customerId })
      .populate('vendor', 'businessName deliveryType')
      .sort({ createdAt: -1 });

    const normalizePlanType = (planType) => {
      if (!planType) return 'Plan';
      return String(planType)
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    };

    const normalizeMealType = (mealType) => {
      if (!mealType) return '';
      const normalized = String(mealType).toLowerCase();
      if (normalized === 'nonveg') return 'Non-Veg';
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    };

    const formatStatus = (status, isExpiredByDate) => {
      if (isExpiredByDate) return 'Expired';
      const normalized = String(status || '').toLowerCase();
      if (!normalized) return 'Pending';
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    };

    const formattedOrders = subscriptions.map((sub) => {
      const statusValue = String(sub.status || '').toLowerCase();
      const endDate = sub.endDate ? new Date(sub.endDate) : null;
      const isExpiredByDate = Boolean(endDate && endDate < today);
      const isPast =
        isExpiredByDate ||
        ['cancelled', 'expired'].includes(statusValue);

      return {
        _id: sub._id,
        vendorName: sub.vendor?.businessName || 'Unknown Vendor',
        orderNumber: String(sub._id).slice(-6).toUpperCase(),
        status: formatStatus(sub.status, isExpiredByDate),
        planType: normalizePlanType(sub.planType),
        mealType: normalizeMealType(sub.mealType),
        orderDate: sub.createdAt,
        startDate: sub.startDate,
        endDate: sub.endDate,
        deliveryType: sub.vendor?.deliveryType || 'Delivery',
        totalAmount: sub.price || 0,
        isPast
      };
    });

    const activeOrders = formattedOrders.filter((order) => !order.isPast);
    const pastOrders = formattedOrders.filter((order) => order.isPast);

    res.status(200).json({
      activeOrders,
      pastOrders
    });
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    res.status(500).json({ message: 'Server error fetching orders' });
  }
};

// --- Homemade products marketplace for customers ---
exports.getHomemadeProducts = async (req, res) => {
  try {
    const items = await HomemadeItem.find({
      isActive: true,
      inStock: true,
      stockQuantity: { $gt: 0 }
    })
      .populate('vendor', 'businessName serviceArea')
      .sort({ createdAt: -1 });

    const formattedItems = items
      .filter((item) => item.vendor)
      .map((item) => ({
        _id: item._id,
        name: item.name,
        category: item.category,
        description: item.description,
        imageUrl: item.imageUrl,
        unit: item.unit,
        price: item.price,
        stockQuantity: item.stockQuantity,
        vendorId: item.vendor._id,
        vendorName: item.vendor.businessName,
        serviceArea: item.vendor.serviceArea
      }));

    res.status(200).json(formattedItems);
  } catch (error) {
    console.error("Error fetching homemade products:", error);
    res.status(500).json({ message: 'Server error fetching homemade products' });
  }
};

exports.placeHomemadeOrder = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const { itemId, quantity } = req.body;

    if (!itemId) {
      return res.status(400).json({ message: 'itemId is required.' });
    }

    const parsedQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
    const item = await HomemadeItem.findById(itemId);
    if (!item || !item.isActive || !item.inStock) {
      return res.status(404).json({ message: 'Item is not available for ordering.' });
    }

    const previousStock = item.stockQuantity;
    const updatedItem = await HomemadeItem.findOneAndUpdate(
      {
        _id: itemId,
        isActive: true,
        inStock: true,
        stockQuantity: { $gte: parsedQuantity }
      },
      { $inc: { stockQuantity: -parsedQuantity } },
      { new: true }
    );

    if (!updatedItem) {
      return res.status(400).json({ message: `Only ${previousStock} item(s) left in stock.` });
    }

    if (updatedItem.stockQuantity <= 0 || !updatedItem.isActive) {
      updatedItem.stockQuantity = Math.max(0, updatedItem.stockQuantity);
      updatedItem.inStock = false;
      await updatedItem.save();
    }

    const totalAmount = parsedQuantity * item.price;

    const order = await HomemadeOrder.create({
      customer: customerId,
      vendor: item.vendor,
      item: item._id,
      itemName: item.name,
      itemUnit: item.unit,
      pricePerUnit: item.price,
      quantity: parsedQuantity,
      totalAmount
    });

    await HomemadeStockLog.create({
      vendor: item.vendor,
      item: item._id,
      order: order._id,
      action: 'order_placed',
      quantityChange: -parsedQuantity,
      previousStock,
      newStock: updatedItem.stockQuantity,
      note: `Order placed by customer ${customerId}`
    });

    res.status(201).json({
      message: 'Order placed successfully.',
      order
    });
  } catch (error) {
    console.error("Error placing homemade order:", error);
    res.status(500).json({ message: 'Server error placing homemade order' });
  }
};

exports.getMyHomemadeOrders = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const orders = await HomemadeOrder.find({ customer: customerId })
      .populate('vendor', 'businessName')
      .sort({ createdAt: -1 });

    const formattedOrders = orders.map((order) => ({
      _id: order._id,
      itemName: order.itemName,
      itemUnit: order.itemUnit,
      quantity: order.quantity,
      totalAmount: order.totalAmount,
      status: order.status,
      vendorName: order.vendor?.businessName || 'Unknown Vendor',
      createdAt: order.createdAt
    }));

    res.status(200).json(formattedOrders);
  } catch (error) {
    console.error("Error fetching homemade orders:", error);
    res.status(500).json({ message: 'Server error fetching homemade orders' });
  }
};

// --- Customer Reviews (DB-backed) ---
exports.getCustomerReviews = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    const [allReviews, myReviews] = await Promise.all([
      Review.find({})
        .populate('vendorId', 'name email')
        .populate('customerId', 'name')
        .sort({ createdAt: -1 }),
      Review.find({ customerId: customerId })
        .populate('vendorId', 'name email')
        .sort({ createdAt: -1 })
    ]);

    const formattedAllReviews = allReviews
      .filter((review) => review.vendorId && review.customerId)
      .map((review) => ({
        _id: review._id,
        vendorId: review.vendorId._id,
        vendorName: review.vendorId.name || 'Kitchen',
        customerName: review.customerId.name || 'Student',
        rating: review.rating,
        text: review.comment || '',
        createdAt: review.createdAt,
        isMine: String(review.customerId._id) === String(customerId)
      }));

    const formattedMyReviews = myReviews
      .filter((review) => review.vendorId)
      .map((review) => ({
        _id: review._id,
        vendorId: review.vendorId._id,
        vendorName: review.vendorId.name || 'Kitchen',
        rating: review.rating,
        text: review.comment || '',
        createdAt: review.createdAt
      }));

    res.status(200).json({
      allReviews: formattedAllReviews,
      myReviews: formattedMyReviews
    });
  } catch (error) {
    console.error("Error fetching customer reviews:", error);
    res.status(500).json({ message: 'Server error fetching reviews' });
  }
};

exports.createOrUpdateReview = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const { vendorId, rating, text, comment } = req.body;

    if (!vendorId || !rating) {
      return res.status(400).json({ message: 'vendorId and rating are required.' });
    }

    const parsedRating = Number(rating);
    if (!parsedRating || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ message: 'rating must be a number between 1 and 5.' });
    }

    const reviewComment = comment !== undefined ? String(comment) : (text !== undefined ? String(text) : '');

    const vendorProfile = await VendorProfile.findOne({
      $or: [{ vendorId: vendorId }, { _id: vendorId }]
    });

    // 🔧 FIX: Always use the VendorProfile ObjectId (_id) — this is what the
    // Review schema's `vendor` field and the unique index { vendor, customer }
    // are built on. Using vendorProfile.vendorId (a User _id) here was the
    // source of duplicate-key 500 errors and broken rating recomputation.
    const targetVendorId = vendorProfile ? vendorProfile._id : vendorId;

    // 🔧 FIX: Query matches either schema fields (vendor/customer) or legacy fields (vendorId/customerId).
    // Set both field pairs so MongoDB legacy indexes and queries never get null duplicate key errors.
    const review = await Review.findOneAndUpdate(
      {
        $or: [
          { vendor: targetVendorId, customer: customerId },
          { vendorId: targetVendorId, customerId: customerId }
        ]
      },
      {
        vendor: targetVendorId,
        customer: customerId,
        vendorId: targetVendorId,
        customerId: customerId,
        rating: parsedRating,
        comment: reviewComment,
        text: reviewComment,
      },
      { returnDocument: 'after', new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (vendorProfile) {
      await recomputeVendorRating(vendorProfile._id);
    }

    res.status(200).json({
      message: 'Review saved successfully.',
      review
    });
  } catch (error) {
    console.error("Error saving review:", error);
    res.status(500).json({ message: 'Server error saving review' });
  }
};

exports.deleteMyReview = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const { reviewId } = req.params;

    // 🔧 FIX: Use schema field names (customer, not customerId)
    const review = await Review.findOneAndDelete({ _id: reviewId, customer: customerId });
    if (!review) {
      return res.status(404).json({ message: 'Review not found.' });
    }

    // 🔧 FIX: Use review.vendor (schema field), not review.vendorId
    await recomputeVendorRating(review.vendor);
    res.status(200).json({ message: 'Review deleted successfully.' });
  } catch (error) {
    console.error("Error deleting review:", error);
    res.status(500).json({ message: 'Server error deleting review' });
  }
};

// --- Get Customer Payment Details ---
exports.getCustomerPayments = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    // Fetch the active subscription for this customer
    const activeSub = await Subscription.findOne({
      customer: customerId,
      status: 'active' 
    }).populate('vendor', 'businessName');

    if (!activeSub) {
        return res.status(200).json({
            pendingAmount: 0,
            totalPaid: 0,
            thisMonth: 0,
            transactions: []
        });
    }

    const today = new Date();
    let baseDuration = 30;
    if (activeSub.planType.includes('weekly') || activeSub.planType.includes('7_days')) baseDuration = 7;
    if (activeSub.planType.includes('15_days')) baseDuration = 15;

    const skippedDaysCount = activeSub.skippedDates ? activeSub.skippedDates.length : 0;
    const totalSpan = baseDuration + skippedDaysCount;

    const startDate = new Date(activeSub.startDate || activeSub.createdAt);
    const fallbackEndDate = new Date(startDate);
    fallbackEndDate.setDate(fallbackEndDate.getDate() + totalSpan);
    const endDate = activeSub.endDate ? new Date(activeSub.endDate) : fallbackEndDate;

    const diffTime = endDate.getTime() - today.getTime();
    const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    let pendingAmount = 0;
    let transactions = [];

    // Determine Pending Amount
    if (activeSub.paymentStatus === 'unpaid' || daysLeft <= 5) {
        pendingAmount = activeSub.price;
        // Add a "Pending" transaction record
        transactions.push({
            id: `pending-${activeSub._id}`,
            vendorName: activeSub.vendor.businessName,
            type: 'Subscription',
            status: 'pending',
            date: 'Due Now',
            method: 'Pending',
            amount: activeSub.price
        });
    }

    // Determine Total Paid & This Month (Simplification: Assuming if paid, they paid the price)
    // In a real app, you'd have a separate 'Transactions' table. Here we infer from the subscription state.
    let totalPaid = 0;
    let thisMonthPaid = 0;

    if (activeSub.paymentStatus === 'paid') {
        totalPaid += activeSub.price;
        
        // Check if paid this month
        const paymentDate = activeSub.lastPaymentDate ? new Date(activeSub.lastPaymentDate) : startDate;
        if (paymentDate.getMonth() === today.getMonth() && paymentDate.getFullYear() === today.getFullYear()) {
            thisMonthPaid += activeSub.price;
        }

        // Add a "Paid" transaction record
        const formattedDate = paymentDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        transactions.push({
            id: `paid-${activeSub._id}`,
            vendorName: activeSub.vendor.businessName,
            type: 'Subscription',
            status: 'paid',
            date: formattedDate,
            method: 'UPI / Cash', // Mock method
            amount: activeSub.price
        });
    }

    res.status(200).json({
      pendingAmount,
      totalPaid,
      thisMonth: thisMonthPaid,
      transactions
    });

  } catch (error) {
    console.error("Error fetching customer payments:", error);
    res.status(500).json({ message: 'Server error fetching payments' });
  }
};

exports.getCustomerTransactions = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    const transactions = await Transaction.find({ customerId }).sort({ createdAt: -1 });
    const vendorIds = [...new Set(transactions.map((txn) => txn.vendorId.toString()))];
    const vendorProfiles = await VendorProfile.find({ vendorId: { $in: vendorIds } }).select('vendorId businessName');
    const vendorNameById = vendorProfiles.reduce((acc, profile) => {
      acc[profile.vendorId.toString()] = profile.businessName;
      return acc;
    }, {});

    const formattedTransactions = transactions.map((txn) => ({
      _id: txn._id,
      vendorName: vendorNameById[txn.vendorId.toString()] || 'Kitchen',
      amount: txn.amount,
      paymentMethod: txn.paymentMethod || 'cash',
      planType: txn.planType || '',
      note: txn.note || '',
      date: txn.date || txn.createdAt
    }));

    res.status(200).json(formattedTransactions);
  } catch (error) {
    console.error('Error fetching customer transactions:', error);
    res.status(500).json({ message: 'Server error fetching transactions.' });
  }
};

// POST /api/customer/register
exports.registerCustomer = async (req, res) => {
  try {
    const { name, phone, location, roomNumber } = req.body;
    const { uid, email } = req.firebaseUser; // Comes from our special registration middleware

    console.log('📝 Registration Attempt:', { uid, email, name, phone, location, roomNumber });

    // 1. Check if user already exists
    const existingUser = await User.findOne({ firebaseUid: uid });
    if (existingUser) {
      console.log('⚠️ User already registered:', uid);
      return res.status(400).json({ message: 'User already registered.' });
    }

    // 2. Create the Customer User document
    const newUser = await User.create({
      firebaseUid: uid,
      name: name,
      email: email,
      phone: phone,
      location: location, // e.g., "SCSMCOE Boys Hostel"
      roomNumber: roomNumber,
      role: 'customer' // Crucial: This marks them as a student!
    });

    console.log('✅ User created successfully:', newUser._id);

    res.status(201).json({ 
      message: 'Student successfully registered!', 
      user: newUser 
    });

  } catch (error) {
    console.error("❌ Student Registration Error:", error.message);
    console.error("Full Error:", error);
    res.status(500).json({ message: 'Server error during registration', error: error.message });
  }
};
// GET /api/customer/announcements
exports.getKitchenAnnouncements = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    // 1. Find all active subscriptions for this student to aggregate announcements from all vendors
    const activeSubscriptions = await Subscription.find({ 
      customer: customerId, 
      status: 'active' 
    }).populate('vendor', 'businessName ownerName');

    if (!activeSubscriptions || activeSubscriptions.length === 0) {
      return res.status(200).json({ announcements: [], currentUserId: customerId.toString() });
    }

    // 2. Extract unique vendorIds and build a mapping dictionary for vendorNames
    const vendorNames = {};
    const vendorIds = [];

    activeSubscriptions.forEach((sub) => {
      if (sub.vendor) {
        const vIdStr = sub.vendor._id ? sub.vendor._id.toString() : sub.vendor.toString();
        if (!vendorNames[vIdStr]) {
          vendorIds.push(new mongoose.Types.ObjectId(vIdStr));
          vendorNames[vIdStr] = sub.vendor.businessName || sub.vendor.ownerName || 'Vendor';
        }
      }
    });

    if (vendorIds.length === 0) {
      return res.status(200).json({ announcements: [], currentUserId: customerId.toString() });
    }

    // 3. Fetch announcements from ALL subscribed vendors
    const rawAnnouncements = await Announcement.find({ vendor: { $in: vendorIds } })
      .sort({ createdAt: -1 });

    // 4. Attach vendorName to each announcement object
    const announcements = rawAnnouncements.map((ann) => {
      const annObj = ann.toObject();
      const vIdStr = ann.vendor ? ann.vendor.toString() : '';
      annObj.vendorName = vendorNames[vIdStr] || 'Vendor';
      return annObj;
    });

    // DIAGNOSTIC LOG: Print the first poll's options+voters so we can confirm
    // the voters array reaches the Flutter client and contains the student ID.
    const firstPoll = rawAnnouncements.find(a => a.type === 'Poll');
    if (firstPoll) {
      console.log('[POLL DEBUG] options for', firstPoll._id, ':', JSON.stringify(
        firstPoll.options.map(o => ({ text: o.text, votes: o.votes, voters: o.voters }))
      ));
      console.log('[POLL DEBUG] currentUserId:', customerId);
    }

    res.status(200).json({
      announcements,
      // Include the authenticated student's MongoDB _id so Flutter can check
      // which option they already voted for by matching against voters arrays.
      currentUserId: customerId.toString(),
    });

  } catch (error) {
    console.error("Error fetching kitchen announcements:", error);
    res.status(500).json({ message: 'Server error fetching announcements' });
  }
};

// POST /api/customer/reviews/:vendorId
exports.submitReview = async (req, res) => {
  try {
    const { rating, comment, text } = req.body;
    const vendorIdParam = req.params.vendorId || req.body.vendorId;
    const customerId = req.user.userId || req.user.id;

    if (!vendorIdParam || !customerId) {
      return res.status(400).json({ 
        message: 'Missing vendor or customer ID. Cannot submit review.' 
      });
    }

    const numericRating = Number(rating);
    if (!numericRating || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ message: 'Please provide a valid rating between 1 and 5.' });
    }

    const reviewComment = comment !== undefined ? String(comment) : (text !== undefined ? String(text) : '');

    // 1. Find the Vendor Profile (vendorIdParam could be User ID or VendorProfile _id)
    let vendorProfile = await VendorProfile.findOne({
      $or: [{ vendorId: vendorIdParam }, { _id: vendorIdParam }]
    });

    if (!vendorProfile) {
      return res.status(404).json({ message: 'Vendor not found.' });
    }

    // Determine the target vendor ID to store in the Review model
    const targetVendorId = vendorProfile._id;

    // 2. Upsert the Review (populating both vendor/customer and vendorId/customerId to avoid null index conflicts)
    const review = await Review.findOneAndUpdate(
      {
        $or: [
          { vendor: targetVendorId, customer: customerId },
          { vendorId: targetVendorId, customerId: customerId }
        ]
      },
      { 
        vendor: targetVendorId, 
        customer: customerId, 
        vendorId: targetVendorId, 
        customerId: customerId, 
        rating: numericRating, 
        comment: reviewComment,
        text: reviewComment
      },
      { returnDocument: 'after', new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // 3. Recalculate average rating for the kitchen
    await recomputeVendorRating(vendorProfile._id);

    // Fetch updated vendor profile
    const updatedProfile = await VendorProfile.findById(vendorProfile._id);

    res.status(200).json({ 
      message: 'Review submitted successfully!', 
      newAverage: updatedProfile ? updatedProfile.rating : numericRating,
      totalReviews: updatedProfile ? updatedProfile.totalReviews : 1,
      review
    });

  } catch (error) {
    console.error("Error submitting review:", error);
    res.status(500).json({ message: 'Server error submitting review' });
  }
};

// POST /api/customer/subscriptions/:id/renew
exports.renewSubscription = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const oldSubId = req.params.id;

    // 1. Find the expiring subscription
    const oldSub = await Subscription.findOne({ _id: oldSubId, customer: customerId });
    if (!oldSub) return res.status(404).json({ message: 'Subscription not found.' });

 // 2. SAFETY CHECK: Ensure they haven't already renewed THIS SPECIFIC plan!
    const existingFuturePlan = await Subscription.findOne({
      customer: customerId,
      vendor: oldSub.vendor,
      // 🚨 THE FIX: Make sure we check the specific plan and session!
      planType: oldSub.planType,
      preferredSession: oldSub.preferredSession, 
      startDate: { $gt: oldSub.endDate } // Starts after the current one ends
    });
    
    if (existingFuturePlan) {
      // If the user already has a future plan queued, return it as a successful outcome
      const populated = await Subscription.findById(existingFuturePlan._id).populate('vendor', 'businessName weeklyMenu');
      return res.status(200).json({ message: 'You have already renewed this plan.', subscription: populated });
    }

    // 3. Fetch the Vendor Profile (We do this to get the LATEST prices, in case the vendor raised them)
    const vendor = await VendorProfile.findById(oldSub.vendor);
    if (!vendor) return res.status(404).json({ message: 'Kitchen no longer active.' });

    // 4. Calculate New Dates (Starts the day AFTER the old one ends)
    const newStartDate = new Date(oldSub.endDate);
    newStartDate.setDate(newStartDate.getDate() + 1);
    newStartDate.setHours(0, 0, 0, 0);

    // Determine Duration and Latest Price from customPlans
    let durationDays = 30;
    let newTotalBill = oldSub.totalBill;

    let matchedPlan = null;
    if (vendor.customPlans && Array.isArray(vendor.customPlans) && vendor.customPlans.length > 0) {
      matchedPlan = vendor.customPlans.find(p => 
        p.planName.toLowerCase().trim() === String(oldSub.planType).toLowerCase().trim() ||
        p.planName.toLowerCase().replace(/\s+/g, '_') === String(oldSub.planType).toLowerCase()
      );
    }

    if (matchedPlan) {
      newTotalBill = Number(matchedPlan.price) || oldSub.totalBill;
      durationDays = Number(matchedPlan.durationDays) || 30;
    } else {
      const plan = String(oldSub.planType).toLowerCase();
      if (plan === 'monthly_half') {
        durationDays = 30;
        newTotalBill = vendor.monthlyHalfPrice || oldSub.totalBill;
      } else if (plan === 'weekly') {
        durationDays = 7;
        newTotalBill = vendor.weeklyPrice || oldSub.totalBill;
      } else if (plan === '15_days') {
        durationDays = 15;
        newTotalBill = vendor.weeklyPrice ? Math.round((vendor.weeklyPrice / 7) * 15) : oldSub.totalBill;
      } else if (plan === 'single') {
        return res.status(400).json({ message: 'Single meals cannot be auto-renewed.' });
      }
    }

    const newEndDate = new Date(newStartDate);
    newEndDate.setDate(newEndDate.getDate() + (durationDays - 1));

    // 5. Create the Renewed Plan (Queued as upcoming)
    // NOTE: mark as 'pending' so it doesn't appear as currently active immediately
    // The UI will still surface it as an upcoming plan for this customer only.
// Inside renewSubscription -> Subscription.create
    const renewedSub = await Subscription.create({
      customer: customerId,
      vendor: oldSub.vendor,
      planType: oldSub.planType,
      mealType: oldSub.mealType,
      preferredSession: oldSub.preferredSession,
      startDate: newStartDate,
      endDate: newEndDate,
      vendorConsidersHolidays: oldSub.vendorConsidersHolidays,
      totalBill: newTotalBill,
      paymentStatus: 'unpaid',
      status: 'active' // 🚨 ZERO-TOUCH: Born active, sleeps until startDate!
    });

    res.status(201).json({ 
      message: 'Plan successfully renewed!', 
      subscription: renewedSub 
    });

  } catch (error) {
    console.error("Renewal Error:", error);
    res.status(500).json({ message: 'Server error processing renewal.' });
  }
};
// GET /api/customer/profile
exports.getStudentProfile = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const user = await User.findById(customerId).select('-password'); 
    
    if (!user) return res.status(404).json({ message: 'Student profile not found.' });
    
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching profile.' });
  }
};
// POST: /api/customer/announcements/:announcementId/vote
exports.voteOnPoll = async (req, res) => {
  try {
    const { announcementId } = req.params;
    const { optionIndex } = req.body;
    const studentId = (req.user.userId || req.user.id).toString(); // Force string for safe comparison

    const announcement = await Announcement.findById(announcementId);

    if (!announcement || (announcement.type !== 'Poll' && announcement.type !== 'Meal Selection' && announcement.isMealSelection !== true)) {
      return res.status(400).json({ message: 'Invalid poll' });
    }

    // 🔒 NEW: Prevent voting if the vendor has closed the poll
    if (announcement.isClosed) {
      return res.status(403).json({ message: 'This poll has been closed by the vendor. Voting is no longer allowed.' });
    }

    // 1. Remove the student's vote from ANY previous option they selected
    announcement.options.forEach((opt) => {
      // Convert Mongoose ObjectIds to strings to prevent comparison bugs
      const voterStrings = opt.voters.map(id => id.toString());
      const voterIndex = voterStrings.indexOf(studentId);
      
      if (voterIndex !== -1) {
        opt.voters.splice(voterIndex, 1); // Remove the user ID
        opt.votes = Math.max(0, opt.votes - 1); // Decrease the vote count safely
      }
    });

    // 2. Add the vote to the NEW selected option
    announcement.options[optionIndex].votes += 1;
    announcement.options[optionIndex].voters.push(studentId);

    await announcement.save();

    res.status(200).json({ message: 'Vote updated successfully!', announcement });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error while voting' });
  }
};

// DELETE /api/customer/subscriptions/:id/withdraw
// Allows a student to:
//   * Withdraw a PENDING subscription request (vendor hasn't approved yet)
//   * Cancel an UPCOMING plan (active status but startDate is strictly in the future)
exports.withdrawOrCancelPlan = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const { id } = req.params;

    const subscription = await Subscription.findOne({
      _id: id,
      customer: customerId,
    });

    if (!subscription) {
      return res.status(404).json({ message: 'Subscription not found.' });
    }

    const status = subscription.status?.toString().trim().toLowerCase();
    const now = new Date();

    // Case 1: Pending request - vendor hasn't approved yet
    if (status === 'pending') {
      await Subscription.findByIdAndDelete(id);
      return res.status(200).json({
        message: 'Your subscription request has been withdrawn successfully.',
      });
    }

    // Case 2: Active but start date is strictly in the future
    if (status === 'active' && subscription.startDate && subscription.startDate > now) {
      subscription.status = 'cancelled';
      await subscription.save();
      return res.status(200).json({
        message: 'Your upcoming plan has been cancelled successfully.',
      });
    }

    // Anything else: already started, cannot withdraw
    return res.status(400).json({
      message: 'Cannot cancel a plan that has already started. Contact your kitchen directly.',
    });

  } catch (error) {
    console.error('withdrawOrCancelPlan error:', error);
    res.status(500).json({ message: 'Server error processing your request.' });
  }
};

// =============================================================================
// TRIAL TIFFIN (CUSTOMER SIDE)
// =============================================================================

// POST /customer/book-trial
exports.bookTrial = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;
    const { vendorId, targetDate, targetSession } = req.body;

    if (!vendorId || !targetDate || !targetSession) {
      return res.status(400).json({ message: 'vendorId, targetDate and targetSession are required.' });
    }

    if (!['morning', 'afternoon'].includes(targetSession)) {
      return res.status(400).json({ message: 'targetSession must be "morning" or "afternoon".' });
    }

    // Validate date: must be today or future (IST)
    const todayIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    todayIST.setHours(0, 0, 0, 0);
    const [y, m, d] = targetDate.split('-').map(Number);
    const targetDateObj = new Date(y, m - 1, d, 0, 0, 0, 0);
    if (targetDateObj < todayIST) {
      return res.status(400).json({ message: 'Target date cannot be in the past.' });
    }

    const vendor = await VendorProfile.findById(vendorId);
    if (!vendor) return res.status(404).json({ message: 'Kitchen not found.' });
    if (vendor.status !== 'approved') {
      return res.status(400).json({ message: 'This kitchen is not currently accepting orders.' });
    }

    // Prevent duplicate bookings from same student for same vendor+date+session
    const existing = await TrialOrder.findOne({
      customer: customerId,
      vendor: vendorId,
      targetDate,
      targetSession,
      status: { $ne: 'declined' },
    });
    if (existing) {
      return res.status(409).json({ message: 'You already have a trial booked for this session.' });
    }

    const trial = await TrialOrder.create({
      customer: customerId,
      vendor: vendorId,
      targetDate,
      targetSession,
      price: vendor.trialPrice ?? 0,
      status: 'pending',
    });

    // Notify vendor (best-effort)
    try {
      const vendorUser = await User.findById(vendor.vendorId, 'fcmToken').lean();
      if (vendorUser?.fcmToken) {
        await sendPushNotification(
          vendorUser.fcmToken,
          '🥑 New Trial Tiffin Request',
          `A student wants to try your tiffin on ${targetDate} (${targetSession === 'morning' ? 'Lunch' : 'Dinner'}).`,
        );
      }
    } catch (notifErr) {
      console.error('Trial booking notification error (non-fatal):', notifErr);
    }

    res.status(201).json({
      message: 'Trial tiffin request sent! The kitchen will confirm shortly.',
      trial,
    });
  } catch (error) {
    console.error('bookTrial error:', error);
    res.status(500).json({ message: 'Server error booking trial.' });
  }
};

// GET /customer/my-trials
exports.getMyTrials = async (req, res) => {
  try {
    const customerId = req.user.userId || req.user.id;

    const trials = await TrialOrder.find({ customer: customerId })
      .populate('vendor', 'businessName ownerName phone')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.status(200).json(trials);
  } catch (error) {
    console.error('getMyTrials error:', error);
    res.status(500).json({ message: 'Server error fetching your trials.' });
  }
};
