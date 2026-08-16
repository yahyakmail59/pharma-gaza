-- ============================================================
-- ⚠️ تحذير: هذا الملف يحذف الجداول القديمة نهائياً.
-- ------------------------------------------------------------
-- شغّله فقط إذا كانت قاعدة D1 الحالية تحوي بيانات تجريبية.
--
-- سبب الحاجة إليه: المخطط القديم كان يخزّن الرقم السري نصاً صريحاً
-- في عمود users.pin، والمبالغ بأرقام عشرية (REAL). المخطط الجديد
-- يستخدم pin_hash + pin_salt وأعداداً صحيحة بالأغورة، وأوامر
-- CREATE TABLE IF NOT EXISTS لن تعدّل جدولاً موجوداً.
--
-- إن كان لديك بيانات صيدلية حقيقية على السحابة: لا تشغّل هذا.
-- اطلب سكربت ترحيل يحافظ على البيانات بدل الحذف.
--
-- الترتيب: شغّل هذا الملف أولاً، ثم schema.sql
-- ============================================================

DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS pharmacies;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS stock_moves;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS audit_log;
