package com.livingideas.library;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.util.Locale;

/** Foreground "player" service: media notification (play/pause, volume, next, stop), lock-screen controls and a wake lock while reading aloud. */
public class ReaderAudioService extends Service {
  private static final int NID = 5001;
  private MediaSession session;
  private PowerManager.WakeLock wl;
  private boolean noisyReg = false;

  private final BroadcastReceiver noisy = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) { if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) Speaker.I.pause(); }
  };

  @Override public IBinder onBind(Intent i) { return null; }

  private boolean ar() { return "ar".equals(Locale.getDefault().getLanguage()); }

  private int icon(String n) { return getResources().getIdentifier(n, "drawable", getPackageName()); }

  private PendingIntent act(String a, int code) {
    Intent it = new Intent(this, ReaderAudioService.class).setAction(a);
    int fl = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;
    return PendingIntent.getService(this, code, it, fl);
  }

  private Notification build() {
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      if (nm.getNotificationChannel("li_player") == null) {
        NotificationChannel ch = new NotificationChannel("li_player", ar() ? "مشغّل الصوت" : "Audio player", NotificationManager.IMPORTANCE_LOW);
        ch.setSound(null, null); ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
      }
      b = new Notification.Builder(this, "li_player");
    } else b = new Notification.Builder(this);
    Speaker sp = Speaker.I;
    boolean playing = sp.isPlaying();
    String t = sp.title != null && sp.title.length() > 0 ? sp.title : "Living Ideas";
    String s = sp.sub != null && sp.sub.length() > 0 ? sp.sub : (playing ? (ar() ? "جارٍ الاستماع إلى الكتاب" : "Reading aloud") : (ar() ? "متوقف مؤقتًا" : "Paused"));
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent pi = PendingIntent.getActivity(this, 0, open, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT);
    b.addAction(icon("ic_pl_voldown"), ar() ? "خفض الصوت" : "Volume down", act("voldown", 11));
    b.addAction(icon(playing ? "ic_pl_pause" : "ic_pl_play"), playing ? (ar() ? "إيقاف مؤقت" : "Pause") : (ar() ? "تشغيل" : "Play"), act("toggle", 12));
    b.addAction(icon("ic_pl_volup"), ar() ? "رفع الصوت" : "Volume up", act("volup", 13));
    b.addAction(icon("ic_pl_next"), ar() ? "التالي" : "Next", act("next", 14));
    b.addAction(icon("ic_pl_stop"), ar() ? "إيقاف" : "Stop", act("stop", 15));
    Notification.MediaStyle st = new Notification.MediaStyle().setShowActionsInCompactView(1, 3, 4);
    if (session != null) st.setMediaSession(session.getSessionToken());
    b.setStyle(st);
    b.setContentTitle(t).setContentText(s).setSmallIcon(getApplicationInfo().icon).setOngoing(playing).setOnlyAlertOnce(true).setContentIntent(pi).setShowWhen(false);
    if (Build.VERSION.SDK_INT >= 21) b.setVisibility(Notification.VISIBILITY_PUBLIC);
    return b.build();
  }

  private void state() {
    if (session == null) return;
    try {
      Speaker sp = Speaker.I; boolean playing = sp.isPlaying();
      long acts = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_STOP;
      session.setPlaybackState(new PlaybackState.Builder().setActions(acts).setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f).build());
      session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, sp.title != null && sp.title.length() > 0 ? sp.title : "Living Ideas").putString(MediaMetadata.METADATA_KEY_ARTIST, "Living Ideas").build());
    } catch (Exception ignored) {}
  }

  private void show() {
    try {
      state();
      Notification n = build();
      if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK); else startForeground(NID, n);
    } catch (Exception ignored) {}
  }

  @Override public void onCreate() {
    super.onCreate();
    try {
      session = new MediaSession(this, "li-reader");
      session.setCallback(new MediaSession.Callback() {
        @Override public void onPlay() { Speaker.I.resume(); }
        @Override public void onPause() { Speaker.I.pause(); }
        @Override public void onSkipToNext() { Speaker.I.next(); }
        @Override public void onStop() { Speaker.I.stop(false); }
      });
      session.setActive(true);
    } catch (Exception ignored) {}
    try { registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)); noisyReg = true; } catch (Exception ignored) {}
    try { PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE); wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "li:player"); wl.acquire(8 * 60 * 60 * 1000L); } catch (Exception ignored) {}
    Speaker.I.listener = new Speaker.Listener() {
      @Override public void changed() { show(); }
      @Override public void finished() { stopForeground(true); stopSelf(); }
    };
  }

  @Override public int onStartCommand(Intent i, int flags, int startId) {
    String a = i != null ? i.getAction() : null;
    show(); // must always promote to foreground quickly
    if (a != null) {
      Speaker sp = Speaker.I;
      if ("toggle".equals(a)) sp.toggle();
      else if ("next".equals(a)) sp.next();
      else if ("volup".equals(a)) sp.volume(true);
      else if ("voldown".equals(a)) sp.volume(false);
      else if ("stop".equals(a)) sp.stop(false);
    }
    return START_NOT_STICKY;
  }

  @Override public void onDestroy() {
    try { if (Speaker.I.listener != null) Speaker.I.listener = null; } catch (Exception ignored) {}
    try { if (noisyReg) unregisterReceiver(noisy); } catch (Exception ignored) {}
    try { if (session != null) { session.setActive(false); session.release(); } } catch (Exception ignored) {}
    try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) {}
    try { stopForeground(true); } catch (Exception ignored) {}
    super.onDestroy();
  }
}
