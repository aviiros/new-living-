package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import java.io.File;

/** Writes a WebView's print layout straight into a PDF file (no print dialog). Lives in android.print to reach the package-private callbacks. */
public class PdfPrint {
  private final PrintAttributes attrs;

  public PdfPrint(PrintAttributes attrs) { this.attrs = attrs; }

  public void print(final PrintDocumentAdapter adapter, final File out, final Runnable ok, final Runnable fail) {
    try {
      adapter.onLayout(null, attrs, null, new PrintDocumentAdapter.LayoutResultCallback() {
        @Override public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
          try {
            ParcelFileDescriptor fd = ParcelFileDescriptor.open(out, ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE);
            adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, fd, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
              @Override public void onWriteFinished(PageRange[] pages) { try { adapter.onFinish(); } catch (Exception ignored) {} ok.run(); }
              @Override public void onWriteFailed(CharSequence error) { fail.run(); }
            });
          } catch (Exception e) { fail.run(); }
        }
        @Override public void onLayoutFailed(CharSequence error) { fail.run(); }
      }, null);
    } catch (Exception e) { fail.run(); }
  }
}
