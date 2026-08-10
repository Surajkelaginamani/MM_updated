const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const customerController = require('../controllers/customerController');
const verifyRegistrationToken = require('../middleware/registerAuth');
// ============================================================================
// CUSTOMER API ROUTES (/api/customer)
// ============================================================================
// --- Registration ---
router.post('/register', verifyRegistrationToken, customerController.registerCustomer);

// --- Profile & Dashboard ---
router.get('/profile', verifyToken, customerController.getProfile);
router.put('/profile', verifyToken, customerController.updateProfile);
router.get('/dashboard', verifyToken, customerController.getCustomerDashboard);

// --- Browsing Vendors ---
router.get('/vendors', verifyToken, customerController.getAllVendors);
router.get('/vendors/:id', verifyToken, customerController.getVendorById);

// --- Subscriptions & Plans ---
router.get('/subscriptions', verifyToken, customerController.getMySubscriptions);
router.get('/subscriptions/:id', verifyToken, customerController.getSubscriptionById);
router.post('/subscribe', verifyToken, customerController.createSubscriptionRequest);
router.put('/subscriptions/:id/holidays', verifyToken, customerController.updateHolidays);
router.delete('/subscriptions/:id/withdraw', verifyToken, customerController.withdrawOrCancelPlan);

// --- Menus, Orders, and Payments ---
router.get('/menus', verifyToken, customerController.getSubscribedWeeklyMenus);
router.get('/orders', verifyToken, customerController.getMyOrders);
router.get('/payments', verifyToken, customerController.getCustomerPayments);
router.get('/transactions', verifyToken, customerController.getCustomerTransactions);

// --- Homemade Marketplace ---
router.get('/homemade', verifyToken, customerController.getHomemadeProducts);
router.post('/homemade/order', verifyToken, customerController.placeHomemadeOrder);
router.get('/homemade/orders', verifyToken, customerController.getMyHomemadeOrders);

// --- Reviews ---
router.get('/reviews', verifyToken, customerController.getCustomerReviews);
router.post('/reviews', verifyToken, customerController.createOrUpdateReview);
router.post('/reviews/:vendorId', verifyToken, customerController.submitReview);
router.delete('/reviews/:reviewId', verifyToken, customerController.deleteMyReview);

router.post('/subscriptions', verifyToken, customerController.createSubscriptionRequest);
router.get('/announcements', verifyToken, customerController.getKitchenAnnouncements);
// Alias used by Flutter widget StudentAnnouncementsBanner → calls GET /customer/communication
router.get('/communication', verifyToken, customerController.getKitchenAnnouncements);
router.post('/subscriptions/:id/renew', verifyToken, customerController.renewSubscription);
router.post('/announcements/:announcementId/vote', verifyToken, customerController.voteOnPoll);

// 🥑 Trial Tiffin
router.post('/book-trial', verifyToken, customerController.bookTrial);
router.get('/my-trials', verifyToken, customerController.getMyTrials);

module.exports = router;