package com.livingideas.library;

import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.ActionMode;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;

import java.util.ArrayList;
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
      @JavascriptInterface public void stop() { runOnUiThread(new Runnable() { public void run() { pending.clear(); if (tts != null) try { tts.stop(); } catch (Exception ignored) {} } }); }
    }, "LiNative");
  }

  @Override
  public void onPause() {
    super.onPause();
    if (tts != null) try { tts.stop(); } catch (Exception ignored) {}
  }

  @Override
  public void onDestroy() {
    if (tts != null) try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {}
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
