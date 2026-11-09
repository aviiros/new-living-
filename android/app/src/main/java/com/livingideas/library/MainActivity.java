package com.livingideas.library;

import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.ActionMode;
import android.webkit.JavascriptInterface;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.BridgeActivity;

import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Set;

/**
 * 1) While a book is open the page shows its own highlight/note popup, so the system's text
 *    selection menu is hidden to avoid a double menu.
 * 2) Android's WebView has no working Web Speech API, so the books' "guided reading" would stay
 *    silent. This activity exposes the phone's own text-to-speech engine to the page as LiNative.*
 *    and the book shim (see platform-android.js) rebuilds speechSynthesis on top of it.
 */
public class MainActivity extends BridgeActivity {
  private volatile boolean blockMenu = false;
  private TextToSpeech tts;
  private boolean ttsReady = false, ttsFailed = false;
  private final ArrayList<Object[]> pending = new ArrayList<>();
  private WebView web;
  // ---- offline translation (Google ML Kit, models download once, then work without internet)
  private final HashMap<String, Translator> translators = new HashMap<>();
  private final HashMap<String, Integer> modelState = new HashMap<>(); // 1 = downloading, 2 = ready

  private void trEmit(String id, String kind, String text) {
    js("window.__liTr&&window.__liTr(" + q(id) + "," + q(kind) + "," + JSONObject.quote(text == null ? "" : text) + ")");
  }

  private WebView printView;
  private static abstract class Job implements Runnable { String id; Job(String id) { this.id = id; } }
  private final HashMap<String, ArrayList<Job>> jobWaiters = new HashMap<>();

  private static String why(Exception e) {
    String m = e == null ? "" : e.getMessage();
    if (m == null || m.length() == 0) m = e == null ? "error" : e.getClass().getSimpleName();
    return m.length() > 90 ? m.substring(0, 90) : m;
  }

  private boolean saveToDownloads(java.io.File src, String name) throws Exception {
    java.io.InputStream in = new java.io.FileInputStream(src);
    try {
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        android.content.ContentValues cv = new android.content.ContentValues();
        cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name);
        cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/pdf");
        cv.put(android.provider.MediaStore.Downloads.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/Living Ideas");
        android.net.Uri u = getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (u == null) return false;
        java.io.OutputStream os = getContentResolver().openOutputStream(u);
        byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n); os.close();
        return true;
      }
      java.io.File dir = new java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "Living Ideas");
      if (!dir.exists() && !dir.mkdirs()) return false;
      java.io.OutputStream os = new java.io.FileOutputStream(new java.io.File(dir, name));
      byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) os.write(b, 0, n); os.close();
      return true;
    } finally { try { in.close(); } catch (Exception ignored) {} }
  }

  private boolean saveShot(android.graphics.Bitmap bm) {
    try {
      String name = "LivingIdeas-" + System.currentTimeMillis() + ".png";
      java.io.OutputStream os;
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        android.content.ContentValues cv = new android.content.ContentValues();
        cv.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name);
        cv.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png");
        cv.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/Living Ideas");
        android.net.Uri u = getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
        if (u == null) return false;
        os = getContentResolver().openOutputStream(u);
      } else {
        java.io.File dir = new java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_PICTURES), "Living Ideas");
        if (!dir.exists() && !dir.mkdirs()) return false;
        os = new java.io.FileOutputStream(new java.io.File(dir, name));
      }
      bm.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, os); os.close();
      return true;
    } catch (Exception e) { return false; }
  }

  private void jsShot(final boolean ok) {
    runOnUiThread(new Runnable() { public void run() {
      try { getBridge().getWebView().evaluateJavascript("window.__liShot&&window.__liShot(" + ok + ")", null); } catch (Exception ignored) {}
    } });
  }

  private void jsSaved(final boolean ok, final String name) {
    runOnUiThread(new Runnable() { public void run() {
      try { getBridge().getWebView().evaluateJavascript("window.__liPdfSaved&&window.__liPdfSaved(" + ok + "," + org.json.JSONObject.quote(name) + ")", null); } catch (Exception ignored) {}
    } });
  }

  private boolean online() { try { return getSharedPreferences("li", Context.MODE_PRIVATE).getBoolean("online", false); } catch (Exception e) { return false; } }
  private final java.util.concurrent.ExecutorService net = java.util.concurrent.Executors.newFixedThreadPool(3);

  // Better meaning than the small on-device model: whole paragraphs go to the online translator;
  // if there is no internet (or it fails) the on-device model below is used automatically.
  private static String onlineTranslate(String text, String src, String tgt) throws Exception {
    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + src + "&tl=" + tgt + "&dt=t&ie=UTF-8&oe=UTF-8").openConnection();
    try {
      c.setConnectTimeout(8000); c.setReadTimeout(20000); c.setRequestMethod("POST"); c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
      c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) LivingIdeas");
      byte[] body = ("q=" + java.net.URLEncoder.encode(text, "UTF-8")).getBytes("UTF-8");
      java.io.OutputStream os = c.getOutputStream(); os.write(body); os.close();
      if (c.getResponseCode() != 200) throw new Exception("http " + c.getResponseCode());
      java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); java.io.InputStream in = c.getInputStream(); byte[] buf = new byte[8192]; int n;
      while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
      org.json.JSONArray root = new org.json.JSONArray(bo.toString("UTF-8")), segs = root.getJSONArray(0);
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < segs.length(); i++) { org.json.JSONArray sg = segs.optJSONArray(i); if (sg != null) sb.append(sg.optString(0, "")); }
      String r = sb.toString().trim();
      if (r.length() == 0) throw new Exception("empty");
      return r;
    } finally { c.disconnect(); }
  }

  private void doTranslate(final String id, final String text, final String src, final String tgt) {
    if (!online()) { doTranslateOffline(id, text, src, tgt); return; }
    net.execute(new Runnable() { public void run() {
      try { trEmit(id, "ok", onlineTranslate(text, src, tgt)); }
      catch (Exception e) { runOnUiThread(new Runnable() { public void run() { doTranslateOffline(id, text, src, tgt); } }); }
    } });
  }

  private void doTranslateOffline(final String id, final String text, final String src, final String tgt) {
    final String key = src + ">" + tgt;
    try {
      final String s = TranslateLanguage.fromLanguageTag(src), t = TranslateLanguage.fromLanguageTag(tgt);
      if (s == null || t == null) { trEmit(id, "err", "language " + src + ">" + tgt); return; }
      Translator tr = translators.get(key);
      if (tr == null) {
        tr = Translation.getClient(new TranslatorOptions.Builder().setSourceLanguage(s).setTargetLanguage(t).build());
        translators.put(key, tr);
      }
      final Translator trf = tr;
      final Job run = new Job(id) { public void run() {
        trf.translate(text)
          .addOnSuccessListener(new com.google.android.gms.tasks.OnSuccessListener<String>() { public void onSuccess(String r) { trEmit(id, "ok", r); } })
          .addOnFailureListener(new com.google.android.gms.tasks.OnFailureListener() { public void onFailure(Exception e) { trEmit(id, "err", why(e)); } });
      } };
      Integer st = modelState.get(key);
      if (st != null && st == 2) { run.run(); return; }
      ArrayList<Job> w = jobWaiters.get(key);
      if (w == null) { w = new ArrayList<>(); jobWaiters.put(key, w); }
      w.add(run);
      if (st == null) {
        modelState.put(key, 1);
        trEmit("", "prep", "");
        trf.downloadModelIfNeeded(new DownloadConditions.Builder().build())
          .addOnSuccessListener(new com.google.android.gms.tasks.OnSuccessListener<Void>() { public void onSuccess(Void v) {
            modelState.put(key, 2); trEmit("", "ready", "");
            ArrayList<Job> ws = jobWaiters.remove(key); if (ws != null) for (Job r : ws) r.run();
          } })
          .addOnFailureListener(new com.google.android.gms.tasks.OnFailureListener() { public void onFailure(Exception e) {
            modelState.remove(key); translators.remove(key);
            String m = why(e);
            trEmit("", "nomodel", m);
            ArrayList<Job> ws = jobWaiters.remove(key); if (ws != null) for (Job r : ws) trEmit(r.id, "err", m);
          } });
      }
    } catch (Exception e) { trEmit(id, "err", why(e)); }
  }

  private void js(final String code) {
    final WebView w = web;
    if (w == null) return;
    runOnUiThread(new Runnable() { public void run() { try { w.evaluateJavascript(code, null); } catch (Exception ignored) {} } });
  }

  private static String q(String s) { return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"; }

  private void emit(String id, String type, int a, int b) {
    js("window.__liTts&&window.__liTts(" + q(id) + "," + q(type) + "," + a + "," + b + ")");
  }

  private void ensureTts() {
    if (tts != null || ttsFailed) return;
    try {
      tts = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
        @Override public void onInit(int status) {
          if (status != TextToSpeech.SUCCESS) {
            ttsFailed = true;
            for (Object[] p : pending) emit((String) p[0], "error", 0, 0);
            pending.clear();
            return;
          }
          ttsReady = true;
          tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            // internal id: <jsId>|<piece>|<pieces>|<offset>
            @Override public void onStart(String uid) { String[] p = uid.split("\\|"); if (p.length >= 4 && "0".equals(p[1])) emit(p[0], "start", 0, 0); }
            @Override public void onDone(String uid) { String[] p = uid.split("\\|"); if (p.length >= 4 && Integer.parseInt(p[1]) == Integer.parseInt(p[2]) - 1) emit(p[0], "end", 0, 0); }
            @Override public void onError(String uid) { String[] p = uid.split("\\|"); emit(p[0], "error", 0, 0); }
            @Override public void onStop(String uid, boolean interrupted) {}
            @Override public void onRangeStart(String uid, int start, int end, int frame) {
              String[] p = uid.split("\\|"); if (p.length >= 4) emit(p[0], "boundary", start + Integer.parseInt(p[3]), end - start);
            }
          });
          ArrayList<Object[]> copy = new ArrayList<>(pending); pending.clear();
          for (Object[] p : copy) doSpeak((String) p[0], (String) p[1], (String) p[2], (String) p[3], (Double) p[4], (Double) p[5]);
          emit("", "voices", 0, 0);
        }
      });
    } catch (Exception e) { ttsFailed = true; }
  }

  private void doSpeak(String id, String text, String lang, String voice, double rate, double pitch) {
    if (tts == null) return;
    try {
      boolean set = false;
      if (voice != null && voice.length() > 0 && Build.VERSION.SDK_INT >= 21) {
        Set<Voice> vs = tts.getVoices();
        if (vs != null) for (Voice v : vs) if (voice.equals(v.getName())) { tts.setVoice(v); set = true; break; }
      }
      if (!set) tts.setLanguage(Locale.forLanguageTag(lang != null && lang.length() > 0 ? lang : "ar"));
      tts.setSpeechRate((float) Math.max(0.3, Math.min(3.0, rate)));
      tts.setPitch((float) Math.max(0.3, Math.min(2.0, pitch)));
      int max = 3500, n = (int) Math.ceil(text.length() / (double) max);
      if (n < 1) n = 1;
      int off = 0;
      for (int i = 0; i < n; i++) {
        int end = Math.min(text.length(), off + max);
        if (end < text.length()) { int sp = text.lastIndexOf(' ', end); if (sp > off + 500) end = sp; }
        String piece = text.substring(off, end);
        // recompute total as we go: use n as an upper bound, mark the last piece explicitly
        boolean last = end >= text.length();
        String uid = id + "|" + i + "|" + (last ? i + 1 : n + 1) + "|" + off;
        tts.speak(piece, TextToSpeech.QUEUE_ADD, null, uid);
        off = end; if (last) break;
      }
    } catch (Exception e) { emit(id, "error", 0, 0); }
  }

  @Override
  public void onStart() {
    super.onStart();
    if (getBridge() == null || getBridge().getWebView() == null) return;
    web = getBridge().getWebView();
    // Keep the layout stable: the system font scale must not blow text out of fixed boxes.
    try { web.getSettings().setTextZoom(100); } catch (Exception ignored) {}
    web.addJavascriptInterface(new Object() {
      @JavascriptInterface public void blockMenu(boolean on) { blockMenu = on; }
      @JavascriptInterface public void init() { runOnUiThread(new Runnable() { public void run() { ensureTts(); } }); }
      @JavascriptInterface public String voices() {
        JSONArray out = new JSONArray();
        try {
          if (tts != null && ttsReady && Build.VERSION.SDK_INT >= 21) {
            Set<Voice> vs = tts.getVoices();
            if (vs != null) for (Voice v : vs) { JSONArray o = new JSONArray(); o.put(v.getName()); o.put(v.getLocale().toLanguageTag()); o.put(false); out.put(o); }
          }
        } catch (Exception ignored) {}
        return out.toString();
      }
      @JavascriptInterface public void speak(final String id, final String text, final String lang, final String voice, final double rate, final double pitch) {
        runOnUiThread(new Runnable() { public void run() {
          ensureTts();
          if (ttsFailed) { emit(id, "error", 0, 0); return; }
          if (ttsReady) doSpeak(id, text, lang, voice, rate, pitch);
          else pending.add(new Object[]{id, text, lang, voice, rate, pitch});
        } });
      }
      @JavascriptInterface public void translate(final String id, final String text, final String src, final String tgt) {
        runOnUiThread(new Runnable() { public void run() { doTranslate(id, text, src, tgt); } });
      }
      // Keeps the app alive (with a live progress notification) while a translation runs in the background.
      @JavascriptInterface public void keepAlive(boolean on, String title, String text, int pct) {
        try {
          android.content.Intent it = new android.content.Intent(MainActivity.this, KeepAliveService.class);
          if (!on) { stopService(it); return; }
          it.putExtra("title", title); it.putExtra("text", text); it.putExtra("pct", pct);
          if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(it); else startService(it);
        } catch (Exception ignored) {}
      }
      @JavascriptInterface public void screenshot() {
        runOnUiThread(new Runnable() { public void run() {
          try {
            final android.view.View v = getWindow().getDecorView();
            final android.graphics.Bitmap bm = android.graphics.Bitmap.createBitmap(v.getWidth(), v.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
            if (android.os.Build.VERSION.SDK_INT >= 26) {
              android.view.PixelCopy.request(getWindow(), bm, new android.view.PixelCopy.OnPixelCopyFinishedListener() { public void onPixelCopyFinished(int r) { jsShot(r == android.view.PixelCopy.SUCCESS && saveShot(bm)); } }, new android.os.Handler(android.os.Looper.getMainLooper()));
            } else { v.draw(new android.graphics.Canvas(bm)); jsShot(saveShot(bm)); }
          } catch (Exception e) { jsShot(false); }
        } });
      }
      @JavascriptInterface public boolean kaStopped() { boolean v = KeepAliveService.stopRequested; KeepAliveService.stopRequested = false; return v; }
      @JavascriptInterface public boolean online() { return MainActivity.this.online(); }
      @JavascriptInterface public void setOnline(boolean v) { try { getSharedPreferences("li", Context.MODE_PRIVATE).edit().putBoolean("online", v).apply(); } catch (Exception ignored) {} }
      @JavascriptInterface public void printHtml(final String html, final String name) {
        runOnUiThread(new Runnable() { public void run() {
          try {
            final WebView w = new WebView(MainActivity.this);
            printView = w;
            final String job = (name == null || name.length() == 0) ? "Living Ideas" : name;
            w.setWebViewClient(new WebViewClient() {
              @Override public void onPageFinished(WebView v, String url) {
                final PrintAttributes pa = new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300)).setMinMargins(new PrintAttributes.Margins(350, 350, 350, 350)).build();
                final String fname = job.replaceAll("[\\\\/:*?\"<>|]+", " ").trim() + ".pdf";
                try {
                  final java.io.File tmp = new java.io.File(getCacheDir(), "export-" + System.currentTimeMillis() + ".pdf");
                  new android.print.PdfPrint(pa).print(v.createPrintDocumentAdapter(job), tmp, new Runnable() { public void run() {
                    boolean saved = false;
                    try { saved = saveToDownloads(tmp, fname); } catch (Exception ignored) {}
                    try { tmp.delete(); } catch (Exception ignored) {}
                    if (!saved) { try { PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE); pm.print(job, printView.createPrintDocumentAdapter(job), pa); return; } catch (Exception ignored) {} }
                    jsSaved(saved, fname);
                    printView = null;
                  } }, new Runnable() { public void run() { jsSaved(false, fname); printView = null; } });
                } catch (Exception e) {
                  try { PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE); pm.print(job, v.createPrintDocumentAdapter(job), pa); } catch (Exception ignored) {}
                }
              }
            });
            w.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
          } catch (Exception ignored) {}
        } });
      }
      @JavascriptInterface public void stop() { runOnUiThread(new Runnable() { public void run() { pending.clear(); if (tts != null) try { tts.stop(); } catch (Exception ignored) {} } }); }
    }, "LiNative");
  }

  @Override
  public void onPause() {
    super.onPause();
    try { getBridge().getWebView().resumeTimers(); } catch (Exception ignored) {}
    if (tts != null) try { tts.stop(); } catch (Exception ignored) {}
  }

  @Override
  public void onDestroy() {
    if (tts != null) try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {}
    for (Translator t : translators.values()) try { t.close(); } catch (Exception ignored) {}
    super.onDestroy();
  }

  @Override
  public void onActionModeStarted(ActionMode mode) {
    super.onActionModeStarted(mode);
    if (!blockMenu || mode == null) return;
    try { mode.getMenu().clear(); } catch (Exception ignored) {}
    if (Build.VERSION.SDK_INT >= 23) {
      try { mode.hide(Long.MAX_VALUE / 4); } catch (Exception ignored) {}
    }
  }
}
