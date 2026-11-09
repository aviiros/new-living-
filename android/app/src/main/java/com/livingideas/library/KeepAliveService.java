package com.livingideas.library;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Foreground service: keeps the process alive while a book is being translated and shows the real progress. */
public class KeepAliveService extends Service {
  public static volatile boolean stopRequested = false;
  private PowerManager.WakeLock wl;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent i, int flags, int startId) {
    if (i != null && "stop".equals(i.getAction())) { stopRequested = true; stopForeground(true); stopSelf(); return START_NOT_STICKY; }
    String title = i != null && i.getStringExtra("title") != null ? i.getStringExtra("title") : "Living Ideas";
    String text = i != null && i.getStringExtra("text") != null ? i.getStringExtra("text") : "";
    int pct = i != null ? i.getIntExtra("pct", 0) : 0;
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      if (nm.getNotificationChannel("li_bg") == null) nm.createNotificationChannel(new NotificationChannel("li_bg", "Translation", NotificationManager.IMPORTANCE_LOW));
      b = new Notification.Builder(this, "li_bg");
    } else b = new Notification.Builder(this);
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent pi = PendingIntent.getActivity(this, 0, open, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT);
    Intent stopIt = new Intent(this, KeepAliveService.class).setAction("stop");
    PendingIntent sp = PendingIntent.getService(this, 1, stopIt, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT);
    b.addAction(new Notification.Action.Builder(null, "\u0625\u064a\u0642\u0627\u0641 / Stop", sp).build());
    b.setContentTitle(title).setContentText(text).setSmallIcon(getApplicationInfo().icon).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(pi).setProgress(100, Math.max(0, Math.min(100, pct)), false);
    if (Build.VERSION.SDK_INT >= 29) startForeground(4711, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(4711, b.build());
    if (wl == null) { try { PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE); wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "li:translate"); wl.acquire(6 * 60 * 60 * 1000L); } catch (Exception ignored) {} }
    return START_NOT_STICKY;
  }

  @Override public void onTaskRemoved(Intent rootIntent) { stopForeground(true); stopSelf(); super.onTaskRemoved(rootIntent); }

  @Override public void onDestroy() {
    try { stopForeground(true); } catch (Exception ignored) {}
    try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) {}
    wl = null;
    super.onDestroy();
  }
}
