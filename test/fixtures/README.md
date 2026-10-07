# شهادات اختبار PayPal

الملفان `paypal-test-only-certificate.pem` و`paypal-test-only-key.pem` شهادة ومفتاح RSA اصطناعيان عامان ضمن test fixtures. لا يخصان PayPal أوحسابًا حقيقيًا، ولا يمنحان أي اعتماد للمنتج. تتلقى الاختبارات هذه الشهادة عبر mocked HTTPS fetch محددة النطاق وتوقع raw bytes بنفس عقد Provider؛ الإنتاج لا يقرأ أي fixture.

أُنشئا عبر OpenSSL داخل Docker للتطوير، ولا تحتاج الاختبارات إلى OpenSSL بعد حفظهما. تنتهي الشهادة في2036؛ يمكن إعادة توليد الزوج معًا قبل انتهاء صلاحيته للاختبارات فقط. لا تستخدمهما فيdeployment أوconnection credentials.
