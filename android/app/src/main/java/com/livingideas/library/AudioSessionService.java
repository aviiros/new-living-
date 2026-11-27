package com.livingideas.library;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.util.Locale;

/** Foreground media session for the standalone audiobook player (HTML Audio in player.html). Gives notification, lock-screen controls and keeps the process alive with the screen off. */
public class AudioSessionService extends Service {
  public interface Cmd { void run(String c, double v); }
  public static volatile Cmd cmd;
  public static volatile String title = "";
  public static volatile boolean playing = false;
  public static volatile long pos = 0, dur = 0;
  public static volatile AudioSessionService inst;

  private static final int NID = 5002;
  private MediaSession session;
  private PowerManager.WakeLock wl;

  @Override public IBinder onBind(Intent i) { return null; }
  private boolean ar() { return "ar".equals(Locale.getDefault().getLanguage()); }
  private int icon(String n) { return getResources().getIdentifier(n, "drawable", getPackageName()); }

  private PendingIntent act(String a, int code) {
    Intent it = new Intent(this, AudioSessionService.class).setAction(a);
    return PendingIntent.getService(this, 200 + code, it, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT);
  }

  private Notification build() {
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      if (nm.getNotificationChannel("li_audiobook") == null) {
        NotificationChannel ch = new NotificationChannel("li_audiobook", ar() ? "الكتب الصوتية" : "Audiobooks", NotificationManager.IMPORTANCE_LOW);
        ch.setSound(null, null); ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
      }
      b = new Notification.Builder(this, "li_audiobook");
    } else b = new Notification.Builder(this);
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent pi = PendingIntent.getActivity(this, 0, open, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT);
    b.addAction(icon("ic_pl_voldown"), ar() ? "رجوع ١٥ ثانية" : "Back 15s", act("back", 1));
    b.addAction(icon(playing ? "ic_pl_pause" : "ic_pl_play"), playing ? (ar() ? "إيقاف مؤقت" : "Pause") : (ar() ? "تشغيل" : "Play"), act("toggle", 2));
    b.addAction(icon("ic_pl_next"), ar() ? "تقدم ٣٠ ثانية" : "Forward 30s", act("fwd", 3));
    b.addAction(icon("ic_pl_stop"), ar() ? "إيقاف" : "Stop", act("stop", 4));
    Notification.MediaStyle st = new Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2);
    if (session != null) st.setMediaSession(session.getSessionToken());
    b.setStyle(st);
    b.setContentTitle(title.length() > 0 ? title : "Living Ideas").setContentText(playing ? (ar() ? "جارٍ التشغيل" : "Playing") : (ar() ? "متوقف مؤقتًا" : "Paused"))
      .setSmallIcon(getApplicationInfo().icon).setOngoing(playing).setOnlyAlertOnce(true).setContentIntent(pi).setShowWhen(false);
    if (Build.VERSION.SDK_INT >= 21) b.setVisibility(Notification.VISIBILITY_PUBLIC);
    return b.build();
  }

  private void state() {
    if (session == null) return;
    try {
      long acts = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_FAST_FORWARD | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
      session.setPlaybackState(new PlaybackState.Builder().setActions(acts).setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, pos * 1000L, playing ? 1f : 0f).build());
      MediaMetadata.Builder m = new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, title.length() > 0 ? title : "Living Ideas").putString(MediaMetadata.METADATA_KEY_ARTIST, "Living Ideas");
      if (dur > 0) m.putLong(MediaMetadata.METADATA_KEY_DURATION, dur * 1000L);
      session.setMetadata(m.build());
    } catch (Exception e) { Log.w("LiAudio", "state: " + e); }
  }

  /** Called from the JS bridge (UI thread). */
  public void refresh() {
    try {
      state();
      Notification n = build();
      if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK); else startForeground(NID, n);
    } catch (Exception e) { Log.e("LiAudio", "refresh FAILED: " + e); }
  }

  private void send(String c, double v) { Cmd k = cmd; Log.i("LiAudio", "cmd " + c); if (k != null) k.run(c, v); }

  @Override public void onCreate() {
    super.onCreate();
    inst = this;
    try {
      session = new MediaSession(this, "li-audiobook");
      session.setCallback(new MediaSession.Callback() {
        @Override public void onPlay() { send("play", 0); }
        @Override public void onPause() { send("pause", 0); }
        @Override public void onFastForward() { send("fwd", 30); }
        @Override public void onRewind() { send("back", 15); }
        @Override public void onSeekTo(long p) { send("seek", p / 1000.0); }
        @Override public void onStop() { send("pause", 0); stopForeground(true); stopSelf(); }
      });
      session.setActive(true);
    } catch (Exception e) { Log.e("LiAudio", "MediaSession FAILED: " + e); }
    try { PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE); wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "li:audiobook"); wl.acquire(10 * 60 * 60 * 1000L); } catch (Exception ignored) {}
  }

  @Override public int onStartCommand(Intent i, int flags, int startId) {
    String a = i != null ? i.getAction() : null;
    refresh(); // always promote to foreground quickly
    if (a != null) {
      if ("toggle".equals(a)) send("toggle", 0);
      else if ("fwd".equals(a)) send("fwd", 30);
      else if ("back".equals(a)) send("back", 15);
      else if ("stop".equals(a)) { send("pause", 0); stopForeground(true); stopSelf(); }
    }
    return START_NOT_STICKY;
  }

  @Override public void onDestroy() {
    inst = null;
    try { if (session != null) { session.setActive(false); session.release(); } } catch (Exception ignored) {}
    try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) {}
    super.onDestroy();
  }
}
