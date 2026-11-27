package com.livingideas.library;

import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;
import java.util.Set;

/**
 * The one reading-aloud engine of the app. It lives in the app process (not in the page), keeps its own queue of sentences and goes on
 * speaking by itself when the page is frozen by the phone (screen off, another app in front). The page only receives small batched
 * events (start / end of a sentence) so it can follow along when it is awake. All methods run on the main thread.
 */
public final class Speaker {
  public static final Speaker I = new Speaker();

  public interface Sink { void events(String jsonArray); }
  public interface Listener { void changed(); void finished(); }

  static final class Item { String id, text, lang, voice, g; float rate = 1f, pitch = 1f, vol = 1f; boolean b; }

  private final Handler main = new Handler(Looper.getMainLooper());
  private Context ctx;
  private TextToSpeech tts;
  private boolean ready = false, failed = false;
  private final ArrayList<Item> items = new ArrayList<>();
  private int cur = 0, fed = 0, gen = 0, speaking = -1;
  public boolean paused = false;
  private boolean resumeOnGain = false, serviceUp = false;
  private final ArrayList<String> evq = new ArrayList<>();
  private boolean flushPending = false;
  public volatile Sink sink;
  public volatile Listener listener;
  public String title = "", sub = "";
  private AudioManager am;
  private AudioFocusRequest focusReq;
  private final Runnable idleStop = new Runnable() { public void run() { if (cur >= items.size() && !paused) shutdown(false); } };

  private final AudioManager.OnAudioFocusChangeListener focus = new AudioManager.OnAudioFocusChangeListener() {
    @Override public void onAudioFocusChange(int c) {
      if (c == AudioManager.AUDIOFOCUS_LOSS) { resumeOnGain = false; if (isActive() && !paused) pause(); }
      else if (c == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || c == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) { if (isActive() && !paused) { resumeOnGain = true; pause(); } }
      else if (c == AudioManager.AUDIOFOCUS_GAIN) { if (resumeOnGain) { resumeOnGain = false; resume(); } }
    }
  };

  private Speaker() {}

  public boolean isActive() { return cur < items.size() || speaking >= 0; }
  public boolean isPlaying() { return isActive() && !paused; }

  // ---- engine
  public void init(Context c) {
    ctx = c.getApplicationContext();
    if (am == null) am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
    if (tts != null || failed) return;
    try {
      tts = new TextToSpeech(ctx, new TextToSpeech.OnInitListener() {
        @Override public void onInit(final int status) {
          main.post(new Runnable() { public void run() {
            if (status != TextToSpeech.SUCCESS) { failed = true; diag("TextToSpeech init FAILED status=" + status + ": no speech engine is available on this device (install or enable one in Android settings)", true); failAll(); return; }
            ready = true;
            try { diag("TextToSpeech ready, engine=" + tts.getDefaultEngine(), false); } catch (Exception ignored) {}
            try {
              if (Build.VERSION.SDK_INT >= 21) tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            } catch (Exception ignored) {}
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
              @Override public void onStart(final String uid) { main.post(new Runnable() { public void run() { onStartU(uid); } }); }
              @Override public void onDone(final String uid) { main.post(new Runnable() { public void run() { onDoneU(uid); } }); }
              @Override public void onError(final String uid) { main.post(new Runnable() { public void run() { diag("utterance error (no code) " + uid, true); onErrorU(uid); } }); }
              @Override public void onError(final String uid, final int code) { main.post(new Runnable() { public void run() { diag("utterance error code=" + code + " (" + errName(code) + ") " + uid, true); onErrorU(uid); } }); }
              @Override public void onStop(String uid, boolean interrupted) {}
              @Override public void onRangeStart(final String uid, final int start, final int end, int frame) { main.post(new Runnable() { public void run() { onRangeU(uid, start, end); } }); }
            });
            emit("", "voices", 0, 0);
            feed();
          } });
        }
      });
    } catch (Exception e) { failed = true; }
  }

  // Diagnostics: Logcat (tag LiTts) and the page (Translation language packs > Diagnostics); serious ones also show a message.
  private void diag(String m, boolean err) {
    if (err) android.util.Log.e("LiTts", m); else android.util.Log.d("LiTts", m);
    emit("", (err ? "diagerr:" : "diag:") + m, 0, 0);
  }

  private void failAll() {
    for (int k = cur; k < items.size(); k++) emit(items.get(k).id, "error", 0, 0);
    items.clear(); cur = fed = 0; speaking = -1;
    changed();
  }

  public String voices() {
    JSONArray out = new JSONArray();
    try {
      if (tts != null && ready && Build.VERSION.SDK_INT >= 21) {
        Set<Voice> vs = tts.getVoices();
        if (vs != null) for (Voice v : vs) { JSONArray o = new JSONArray(); o.put(v.getName()); o.put(v.getLocale().toLanguageTag()); o.put(false); out.put(o); }
      }
    } catch (Exception ignored) {}
    return out.toString();
  }

  // ---- queue
  /** items: [{id,t,l,v,r,p,g,b}] */
  public void submit(String json, boolean flush) {
    try {
      JSONArray a = new JSONArray(json);
      if (flush) clearQueue();
      main.removeCallbacks(idleStop);
      for (int i = 0; i < a.length(); i++) {
        JSONObject o = a.getJSONObject(i); Item it = new Item();
        it.id = o.optString("id"); it.text = o.optString("t"); it.lang = o.optString("l"); it.voice = o.optString("v");
        it.rate = (float) Math.max(0.3, Math.min(3.0, o.optDouble("r", 1))); it.pitch = (float) Math.max(0.3, Math.min(2.0, o.optDouble("p", 1)));
        it.vol = (float) Math.max(0.0, Math.min(1.0, o.optDouble("vo", 1)));
        it.g = o.has("g") ? o.optString("g") : it.id; it.b = o.optInt("b", 0) == 1;
        items.add(it);
      }
      if (flush) paused = false;
      startService();
      if (!paused) requestFocus();
      if (ctx != null && tts == null) init(ctx);
      feed();
      changed();
    } catch (Exception ignored) {}
  }

  private void clearQueue() {
    gen++; items.clear(); cur = fed = 0; speaking = -1;
    try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
  }

  private void feed() {
    if (!ready || paused || tts == null) return;
    while (fed < items.size() && fed < cur + 3) { speakItem(fed); fed++; }
  }

  private void speakItem(int k) {
    Item it = items.get(k);
    try {
      boolean set = false;
      if (it.voice != null && it.voice.length() > 0 && Build.VERSION.SDK_INT >= 21) {
        Set<Voice> vs = tts.getVoices();
        if (vs != null) for (Voice v : vs) if (it.voice.equals(v.getName())) { int r = tts.setVoice(v); set = r == TextToSpeech.SUCCESS; if (!set) diag("setVoice(" + it.voice + ") failed code=" + r, true); break; }
        if (!set) diag("voice '" + it.voice + "' not found on this device, using the language voice", false);
      }
      if (!set) {
        String tag = it.lang != null && it.lang.length() > 0 ? it.lang : "ar";
        int r = tts.setLanguage(Locale.forLanguageTag(tag));
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) { diag("setLanguage(" + tag + ") => " + (r == TextToSpeech.LANG_MISSING_DATA ? "MISSING_DATA" : "NOT_SUPPORTED") + ": this device has no voice for '" + tag + "'. Install it in Settings > Text-to-speech.", true); emit(it.id, "error", 0, 0); return; }
        if (k == cur) diag("setLanguage(" + tag + ") ok code=" + r, false);
      }
      tts.setSpeechRate(it.rate); tts.setPitch(it.pitch);
      String text = it.text == null ? "" : it.text;
      int max = 3500, off = 0, i = 0;
      do {
        int end = Math.min(text.length(), off + max);
        if (end < text.length()) { int sp = text.lastIndexOf(' ', end); if (sp > off + 500) end = sp; }
        boolean last = end >= text.length();
        // uid: generation | item | piece | last | offset
        android.os.Bundle vp = new android.os.Bundle(); vp.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, it.vol);
        int sr = tts.speak(text.substring(off, end), TextToSpeech.QUEUE_ADD, vp, gen + "|" + k + "|" + i + "|" + (last ? 1 : 0) + "|" + off);
        if (sr != TextToSpeech.SUCCESS) { diag("tts.speak returned ERROR for item " + k, true); emit(it.id, "error", 0, 0); return; }
        off = end; i++;
        if (last) break;
      } while (true);
    } catch (Exception e) { diag("speak exception: " + e, true); emit(it.id, "error", 0, 0); }
  }

  private static String errName(int c) { switch (c) { case -4: return "ERROR_NOT_INSTALLED_YET"; case -5: return "ERROR_NETWORK_TIMEOUT"; case -6: return "ERROR_NETWORK"; case -7: return "ERROR_SYNTHESIS"; case -8: return "ERROR_SERVICE"; case -9: return "ERROR_OUTPUT"; case -10: return "ERROR_INVALID_REQUEST"; default: return "ERROR"; } }

  private int[] parse(String uid) {
    try {
      String[] p = uid.split("\\|");
      int g = Integer.parseInt(p[0]);
      if (g != gen) return null;
      return new int[]{Integer.parseInt(p[1]), Integer.parseInt(p[2]), Integer.parseInt(p[3]), Integer.parseInt(p[4])};
    } catch (Exception e) { return null; }
  }

  private void onStartU(String uid) {
    int[] p = parse(uid); if (p == null || p[0] >= items.size()) return;
    speaking = p[0]; android.util.Log.d("LiTts", "onStart item " + p[0]);
    if (p[1] == 0) emit(items.get(p[0]).id, "start", 0, 0);
    changed();
  }

  private void onDoneU(String uid) {
    android.util.Log.d("LiTts", "onDone " + uid);
    int[] p = parse(uid); if (p == null || p[0] >= items.size() || p[2] != 1) return;
    Item it = items.get(p[0]);
    emit(it.id, "end", 0, 0);
    it.text = null;
    cur = Math.max(cur, p[0] + 1); speaking = -1;
    if (cur >= items.size()) { finishedQueue(); } else feed();
    changed();
  }

  private void onErrorU(String uid) {
    int[] p = parse(uid); if (p == null || p[0] >= items.size()) return;
    emit(items.get(p[0]).id, "error", 0, 0);
    items.get(p[0]).text = null;
    cur = Math.max(cur, p[0] + 1); speaking = -1;
    if (cur >= items.size()) finishedQueue(); else feed();
    changed();
  }

  private void onRangeU(String uid, int s, int e) {
    int[] p = parse(uid); if (p == null || p[0] >= items.size()) return;
    Item it = items.get(p[0]); if (!it.b) return;
    emit(it.id, "boundary", s + p[3], e - s);
  }

  private void finishedQueue() {
    // keep the service for a short while: the page may be about to send the next sentence
    main.removeCallbacks(idleStop);
    main.postDelayed(idleStop, 20000);
  }

  // ---- controls
  public void pause() {
    if (paused || !isActive()) return;
    paused = true; gen++; speaking = -1;
    try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
    fed = cur;
    emit("", "paused", 0, 0);
    changed();
  }

  public void resume() {
    if (!paused) return;
    paused = false; requestFocus(); feed();
    emit("", "resumed", 0, 0);
    changed();
  }

  public void toggle() { if (paused) resume(); else pause(); }

  /** Jump to the next paragraph (group). The skipped sentences are reported as finished so the page stays in step. */
  public void next() {
    if (cur >= items.size()) return;
    String g0 = items.get(cur).g; int j = cur;
    while (j < items.size() && g0 != null && g0.equals(items.get(j).g)) j++;
    if (j == cur) j = cur + 1;
    for (int k = cur; k < j && k < items.size(); k++) emit(items.get(k).id, "end", 0, 0);
    gen++; speaking = -1;
    try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
    cur = j; fed = cur;
    if (cur >= items.size()) finishedQueue(); else feed();
    changed();
  }

  public void volume(boolean up) {
    try { if (am != null) am.adjustStreamVolume(AudioManager.STREAM_MUSIC, up ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI); } catch (Exception ignored) {}
  }

  /** silent: the page itself cancelled (nothing to report back). Otherwise the user stopped it from the notification / player. */
  // Sleep timer for read-aloud: stops safely when the time is up (the service keeps the process alive while speaking).
  private final android.os.Handler sleepH = new android.os.Handler(android.os.Looper.getMainLooper());
  private Runnable sleepR; private long sleepAt = 0;
  public void sleepTimer(int minutes) {
    if (sleepR != null) sleepH.removeCallbacks(sleepR); sleepR = null; sleepAt = 0;
    if (minutes <= 0) return;
    sleepAt = System.currentTimeMillis() + minutes * 60000L;
    sleepR = new Runnable() { public void run() { sleepAt = 0; sleepR = null; stop(false); } };
    sleepH.postDelayed(sleepR, minutes * 60000L);
  }
  public int sleepLeft() { return sleepAt == 0 ? 0 : (int) Math.max(0, (sleepAt - System.currentTimeMillis()) / 1000); }

  public void stop(boolean silent) {
    clearQueue(); paused = false;
    if (!silent) { emit("", "stopped", 0, 0); shutdown(true); } else { finishedQueue(); changed(); }
  }

  private void shutdown(boolean now) {
    main.removeCallbacks(idleStop);
    abandonFocus();
    if (!now) { items.clear(); cur = fed = 0; }
    stopService();
    Listener l = listener; if (l != null) l.finished();
  }

  public void meta(String t, String s) { t = t == null ? "" : t; s = s == null ? "" : s; if (t.equals(title) && s.equals(sub)) return; title = t; sub = s; changed(); }

  // ---- audio focus
  private void requestFocus() {
    try {
      if (am == null) return;
      if (Build.VERSION.SDK_INT >= 26) {
        if (focusReq == null) focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener(focus, main).build();
        am.requestAudioFocus(focusReq);
      } else am.requestAudioFocus(focus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
    } catch (Exception ignored) {}
  }

  private void abandonFocus() {
    try {
      if (am == null) return;
      if (Build.VERSION.SDK_INT >= 26) { if (focusReq != null) am.abandonAudioFocusRequest(focusReq); } else am.abandonAudioFocus(focus);
    } catch (Exception ignored) {}
  }

  // ---- service
  private void startService() {
    if (ctx == null) return;
    try {
      Intent it = new Intent(ctx, ReaderAudioService.class);
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(it); else ctx.startService(it);
      serviceUp = true; diag("audio service started", false);
    } catch (Exception e) { diag("audio service start FAILED: " + e, true); }
  }

  private void stopService() {
    if (ctx == null) return;
    try { ctx.stopService(new Intent(ctx, ReaderAudioService.class)); } catch (Exception ignored) {}
    serviceUp = false;
  }

  private void changed() { Listener l = listener; if (l != null) l.changed(); }

  // ---- events to the page (batched)
  private void emit(String id, String type, int a, int b) {
    evq.add("[" + JSONObject.quote(id) + "," + JSONObject.quote(type) + "," + a + "," + b + "]");
    if (evq.size() > 4000) evq.subList(0, 1000).clear();
    if (!flushPending) { flushPending = true; main.postDelayed(new Runnable() { public void run() { flush(); } }, 120); }
  }

  public void flush() {
    flushPending = false;
    Sink s = sink;
    if (s == null || evq.isEmpty()) return;
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < evq.size(); i++) { if (i > 0) sb.append(','); sb.append(evq.get(i)); }
    sb.append(']'); evq.clear();
    s.events(sb.toString());
  }

  public void attach(Sink s) { sink = s; }
}
