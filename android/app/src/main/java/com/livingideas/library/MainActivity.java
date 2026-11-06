package com.livingideas.library;

import android.os.Build;
import android.view.ActionMode;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * While a book is open the page shows its own highlight/note popup, so the system's text
 * selection menu (Copy, Select all, Share, Web search...) is hidden to avoid a double menu.
 * Everywhere else (search boxes, forms) the normal system menu is untouched.
 */
public class MainActivity extends BridgeActivity {
  private volatile boolean blockMenu = false;

  @Override
  public void onStart() {
    super.onStart();
    if (getBridge() == null || getBridge().getWebView() == null) return;
    WebView wv = getBridge().getWebView();
    wv.addJavascriptInterface(new Object() {
      @JavascriptInterface
      public void blockMenu(boolean on) { blockMenu = on; }
    }, "LiNative");
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
