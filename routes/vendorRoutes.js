const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const vendorController = require('../controllers/vendorController');
const verifyRegistrationToken = require('../middleware/registerAuth');

// ============================================================================
// VENDOR API ROUTES (/api/vendor)
// ============================================================================
// --- Registration (Uses the special middleware) ---
router.post('/register', verifyRegistrationToken, vendorController.registerNewVendor);
// --- Dashboard & Profile ---
router.get('/dashboard', verifyToken, vendorController.getVendorDashboard);
router.get('/profile', verifyToken, vendorController.getVendorProfileSettings);
router.put('/profile', verifyToken, vendorController.updateVendorProfileSettings);

// --- Students & Requests ---
router.get('/students', verifyToken, vendorController.getVendorStudents);
router.post('/requests/:subscriptionId/reject', verifyToken, vendorController.rejectSubscriptionRequest);
// router.put('/requests/status', ...) — REMOVED (dead code).
// The live approval/rejection path is POST /vendor/subscriptions/respond
// (respondToRequest), which validates vendor ownership, sets startDate+endDate
// on approval, and fires push notifications. Do not re-add this route.

router.get('/subscriptions', verifyToken, vendorController.getVendorSubscriptions);

// --- Menu & Announcements ---
router.get('/communication', verifyToken, vendorController.getCommunicationData);
router.put('/menu', verifyToken, vendorController.updateWeeklyMenu);
router.post('/announcements', verifyToken, vendorController.postAnnouncement);

// --- Deliveries ---
// Change it to this:
router.get('/deliveries/today', verifyToken, vendorController.getTodaysDeliveries);
// Inside routes/vendorRoutes.js
router.post('/deliveries/complete/:subscriptionId', vendorController.markDeliveryComplete);
router.post('/deliveries/reset', verifyToken, vendorController.resetVendorDailyDeliveries);
router.post('/deliveries/trigger', verifyToken, vendorController.triggerDeliveryUpdate);

// --- Payments ---
router.get('/payments', verifyToken, vendorController.getPaymentRecords);
router.post('/payments/:subscriptionId/pay', verifyToken, vendorController.markAsPaid);

// --- Holidays ---
router.get('/holidays', verifyToken, vendorController.getVendorHolidays);
router.post('/holidays', verifyToken, vendorController.addVendorHoliday);
router.delete('/holidays/:holidayId', verifyToken, vendorController.deleteVendorHoliday);

// --- Homemade Store (Inventory & Orders) ---
router.get('/homemade/items', verifyToken, vendorController.getVendorHomemadeItems);
router.post('/homemade/items', verifyToken, vendorController.createVendorHomemadeItem);
router.put('/homemade/items/:itemId', verifyToken, vendorController.updateVendorHomemadeItem);
router.post('/homemade/items/:itemId/restock', verifyToken, vendorController.restockVendorHomemadeItem);

router.get('/homemade/orders', verifyToken, vendorController.getVendorHomemadeOrders);
router.put('/homemade/orders/:orderId/status', verifyToken, vendorController.updateVendorHomemadeOrderStatus);
router.get('/homemade/logs', verifyToken, vendorController.getVendorHomemadeStockLogs);

router.get('/subscriptions/pending', verifyToken, vendorController.getPendingRequests);
router.post('/subscriptions/respond', verifyToken, vendorController.respondToRequest);
router.post('/menu/today', verifyToken, vendorController.updateDailyMenu);
// --- Reviews ---
router.get('/reviews', verifyToken, vendorController.getVendorReviews);
router.get('/customers/active', verifyToken, vendorController.getActiveCustomers);


// Add these to your routes/vendorRoutes.js file
router.put('/subscriptions/:subscriptionId/approve', vendorController.approveSubscription);
router.put('/subscriptions/:subscriptionId/extend-deadline', vendorController.extendPaymentDeadline);

// --- DIGITAL KHATA (LEDGER) ROUTES ---
router.get('/ledger', verifyToken, vendorController.getLedger);
router.put('/subscriptions/:subscriptionId/pay', verifyToken, vendorController.markSubscriptionPaid);
router.get('/reviews', verifyToken, vendorController.getVendorReviews);
router.get('/profile/full', verifyToken, vendorController.getFullProfile);
router.post('/customers/:customerId/pay', verifyToken, vendorController.recordPayment);
router.get('/customers/:customerId/transactions', verifyToken, vendorController.getCustomerTransactions);
router.put('/subscriptions/:id/cancel', verifyToken, vendorController.cancelSubscription);

router.get('/holidays', verifyToken, vendorController.getVendorHolidays);
router.delete('/holidays/:id', verifyToken, vendorController.deleteVendorHoliday);
router.post('/subscriptions/:id/pay', verifyToken,  vendorController.paySubscriptionBill);
// Add these to your vendorRoutes.js file!
router.put('/announcements/:id', verifyToken, vendorController.editAnnouncement);
router.delete('/announcements/:id', verifyToken, vendorController.deleteAnnouncement);
// 🔒 NEW: Poll Lock & Voter List endpoints
router.put('/announcements/:id/toggle-lock', verifyToken, vendorController.togglePollLock);
router.get('/announcements/:id/option/:optionIndex/voters', verifyToken, vendorController.getPollVoters);
module.exports = router;