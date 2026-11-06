package com.livingideas.library;

import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * While a book is open the page shows its own highlight/note popup, so the system's text
 * selection menu (Copy, Select all, Share, Web search…) is emptied to avoid a double menu.
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
    wv.setCustomSelectionActionModeCallback(new ActionMode.Callback2() {
      @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) { if (blockMenu) menu.clear(); return true; }
      @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) { if (blockMenu) menu.clear(); return true; }
      @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) { return false; }
      @Override public void onDestroyActionMode(ActionMode mode) {}
      @Override public void onGetContentRect(ActionMode mode, View view, android.graphics.Rect outRect) {
        super.onGetContentRect(mode, view, outRect);
      }
    });
  }
}
