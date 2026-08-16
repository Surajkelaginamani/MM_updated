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

// --- Students, Subscriptions & Requests ---
router.get('/students', verifyToken, vendorController.getVendorStudents);
router.post('/requests/:subscriptionId/reject', verifyToken, vendorController.rejectSubscriptionRequest);

// IMPORTANT: Specific /subscriptions/* subpaths must be registered BEFORE parameterized /subscriptions/:id
router.get('/subscriptions/pending', verifyToken, vendorController.getPendingRequests);
router.post('/subscriptions/respond', verifyToken, vendorController.respondToRequest);
router.get('/subscriptions', verifyToken, vendorController.getVendorSubscriptions);
router.get('/subscriptions/:id', verifyToken, vendorController.getVendorSubscriptionById);

// --- Menu & Announcements ---
router.get('/communication', verifyToken, vendorController.getCommunicationData);
router.put('/menu', verifyToken, vendorController.updateWeeklyMenu);
router.post('/announcements', verifyToken, vendorController.postAnnouncement);
router.post('/menu/today', verifyToken, vendorController.updateDailyMenu);
router.delete('/menu/today', verifyToken, vendorController.deleteDailyMenu);

// --- Deliveries ---
router.get('/deliveries/today', verifyToken, vendorController.getTodaysDeliveries);
router.post('/deliveries/notify-location', verifyToken, vendorController.notifyLocationArrival);
router.post('/deliveries/complete/:subscriptionId', vendorController.markDeliveryComplete);
router.post('/deliveries/reset', verifyToken, vendorController.resetVendorDailyDeliveries);
router.post('/deliveries/trigger', verifyToken, vendorController.triggerDeliveryUpdate);

// --- Payments ---
router.get('/payments', verifyToken, vendorController.getPaymentRecords);
router.post('/payments/:subscriptionId/pay', verifyToken, vendorController.markAsPaid);

// --- Holidays ---
router.get('/holidays', verifyToken, vendorController.getVendorHolidays);
router.post('/holidays', verifyToken, vendorController.addVendorHoliday);
router.delete('/holidays/:id', verifyToken, vendorController.deleteVendorHoliday);

// --- Homemade Store (Inventory & Orders) ---
router.get('/homemade/items', verifyToken, vendorController.getVendorHomemadeItems);
router.post('/homemade/items', verifyToken, vendorController.createVendorHomemadeItem);
router.put('/homemade/items/:itemId', verifyToken, vendorController.updateVendorHomemadeItem);
router.post('/homemade/items/:itemId/restock', verifyToken, vendorController.restockVendorHomemadeItem);

router.get('/homemade/orders', verifyToken, vendorController.getVendorHomemadeOrders);
router.put('/homemade/orders/:orderId/status', verifyToken, vendorController.updateVendorHomemadeOrderStatus);
router.get('/homemade/logs', verifyToken, vendorController.getVendorHomemadeStockLogs);

// --- Reviews & Customers ---
router.get('/reviews', verifyToken, vendorController.getVendorReviews);
router.get('/customers/active', verifyToken, vendorController.getActiveCustomers);

// --- Subscription Actions ---
router.put('/subscriptions/:subscriptionId/approve', vendorController.approveSubscription);
router.put('/subscriptions/:subscriptionId/extend-deadline', vendorController.extendPaymentDeadline);

// --- DIGITAL KHATA (LEDGER) ROUTES ---
router.get('/ledger', verifyToken, vendorController.getLedger);
router.put('/subscriptions/:subscriptionId/pay', verifyToken, vendorController.markSubscriptionPaid);
router.get('/profile/full', verifyToken, vendorController.getFullProfile);
router.post('/customers/:customerId/pay', verifyToken, vendorController.recordPayment);
router.get('/customers/:customerId/transactions', verifyToken, vendorController.getCustomerTransactions);
router.put('/subscriptions/:id/cancel', verifyToken, vendorController.cancelSubscription);
router.put('/subscriptions/:id/pause',  verifyToken, vendorController.pauseSubscription);
router.put('/subscriptions/:id/resume', verifyToken, vendorController.resumeSubscription);
router.post('/subscriptions/:id/pay', verifyToken,  vendorController.paySubscriptionBill);

// --- Announcements Management ---
router.put('/announcements/:id', verifyToken, vendorController.editAnnouncement);
router.delete('/announcements/:id', verifyToken, vendorController.deleteAnnouncement);
// 🔒 Poll Lock & Voter List endpoints
router.put('/announcements/:id/toggle-lock', verifyToken, vendorController.togglePollLock);
router.get('/announcements/:id/option/:optionIndex/voters', verifyToken, vendorController.getPollVoters);

// 🥑 Trial Tiffin Management
router.get('/trials', verifyToken, vendorController.getTrialOrders);
router.put('/trials/:id/respond', verifyToken, vendorController.respondToTrialOrder);

module.exports = router;