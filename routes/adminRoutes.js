const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const adminController = require('../controllers/adminController');

// ── Role-guard middleware ─────────────────────────────────────────────────────

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can access this route.' });
  }
  next();
};

// A super admin is still role:'admin' — this checks the extra isSuperAdmin flag.
const requireSuperAdmin = (req, res, next) => {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({
      message: 'Forbidden: Only the Super Admin can perform this action.',
    });
  }
  next();
};

// ── Routes ───────────────────────────────────────────────────────────────────

// Legacy unprotected admin registration (kept for backward compatibility — consider removing)
router.post('/register', adminController.registerAdmin);

router.get('/dashboard', verifyToken, requireAdmin, adminController.getAdminDashboard);
router.post('/vendor/status', verifyToken, requireAdmin, adminController.updateVendorStatus);
router.get('/vendors', verifyToken, requireAdmin, adminController.getAllVendors);
router.get('/students', verifyToken, requireAdmin, adminController.getAllStudents);

// ── Super Admin only ──────────────────────────────────────────────────────────

// POST /api/admin/create-admin
// Creates a new admin account. Requires: valid token + admin role + isSuperAdmin flag.
router.post(
  '/create-admin',
  verifyToken,
  requireAdmin,
  requireSuperAdmin,
  adminController.createAdmin,
);

module.exports = router;
