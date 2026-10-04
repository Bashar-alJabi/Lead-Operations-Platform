# ملفات Media اختبارية

كل الملفات مولدة محلياً بـFFmpeg 9.0.1 من `lavfi sine/color/testsrc`؛ لا بيانات عميل أو ملفات خارجية أو حقوق لطرف ثالث. مدة الصوت والفيديو0.15 ثانية، وanimated WebP0.2 ثانية. تحفظ bytes الحقيقية الصغيرة في Git لتكون اختبارات النوع/codec قابلة للتكرار دون توليد ملفات في كل CI run. `ffprobe` من FFmpeg installation موثوقة مطلوبة لاختبارات audio/video وruntime؛ لا FFmpeg encoder dependency وقت التشغيل.

التوليد: `sine=frequency=440:duration=0.15` مع `libopus`/`libmp3lame`/`aac` للـtone؛ `color=c=blue:s=64x64:d=0.15` مع `libx264 -pix_fmt yuv420p` وAAC للفيديو و`-movflags +faststart`. WebP ثابتة من `color=c=blue:s=512x512` و`-frames:v 1 -c:v libwebp -lossless 1`؛ المتحركة من `testsrc=size=512x512:duration=0.2:rate=10 -c:v libwebp_anim -loop 0`. `vorbis.ogg` و`mpeg4.mp4` تستعملان `libvorbis` و`mpeg4` عمدًا لاختبار رفض codecs غير المدعومة.

هذه الملفات تثبت parsing/validation محلية فقط؛ Provider/Scanner fakes في integration/E2E لا تثبت Meta live أو ClamAV scan جديداً. تحقق ClamAV الفعلي مسجل في checkpoints السابقة.
