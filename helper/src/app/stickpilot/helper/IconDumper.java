package app.stickpilot.helper;

import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;

/**
 * Runs on the device with app_process (like the scrcpy server) and prints each
 * app's TV banner and launcher icon as base64 PNG, one per line:
 *
 *     <package> TAB banner|icon TAB <base64 png>
 *
 * Usage: app_process / app.stickpilot.helper.IconDumper <iconSize> <package>...
 *
 * Android renders the images itself, so vector and adaptive icons work too.
 * Hidden APIs are reached by reflection; app_process isn't subject to the
 * hidden-API restrictions that apply to installed apps.
 */
public final class IconDumper {
    /** xhdpi: TV banners come out at their usual 320x180 */
    private static final int DENSITY = 320;
    private static final int UI_MODE_TYPE_TELEVISION = 0x04;
    private static final int UI_MODE_NIGHT_YES = 0x20;
    private static final int MAX_SIDE = 640;

    public static void main(String[] args) throws Exception {
        int iconSize = Integer.parseInt(args[0]);
        Object pm = packageManager();
        for (int i = 1; i < args.length; i++) {
            String pkg = args[i];
            try {
                ApplicationInfo ai = appInfo(pm, pkg);
                if (ai == null) continue;
                Resources res = resources(ai);
                if (ai.banner != 0) emit(pkg, "banner", render(res, ai.banner, 0, 0));
                if (ai.icon != 0) emit(pkg, "icon", render(res, ai.icon, iconSize, iconSize));
            } catch (Throwable t) {
                System.out.println(pkg + "\terror\t" + t);
            }
            System.out.flush();
        }
    }

    private static Object packageManager() throws Exception {
        Class<?> sm = Class.forName("android.os.ServiceManager");
        IBinder binder = (IBinder) sm.getMethod("getService", String.class).invoke(null, "package");
        Class<?> stub = Class.forName("android.content.pm.IPackageManager$Stub");
        return stub.getMethod("asInterface", IBinder.class).invoke(null, binder);
    }

    private static ApplicationInfo appInfo(Object pm, String pkg) throws Exception {
        // getApplicationInfo(package, flags, userId); flags became a long in Android 13
        for (Method m : pm.getClass().getMethods()) {
            if (!m.getName().equals("getApplicationInfo") || m.getParameterTypes().length != 3) continue;
            Object flags = m.getParameterTypes()[1] == long.class ? (Object) 0L : (Object) 0;
            return (ApplicationInfo) m.invoke(pm, pkg, flags, 0);
        }
        return null;
    }

    private static Resources resources(ApplicationInfo ai) throws Exception {
        AssetManager assets = AssetManager.class.newInstance();
        Method addAssetPath = AssetManager.class.getMethod("addAssetPath", String.class);
        addAssetPath.invoke(assets, ai.sourceDir);
        if (ai.splitSourceDirs != null) {
            for (String split : ai.splitSourceDirs) addAssetPath.invoke(assets, split);
        }
        DisplayMetrics metrics = new DisplayMetrics();
        metrics.setToDefaults();
        metrics.densityDpi = DENSITY;
        metrics.density = DENSITY / 160f;
        metrics.scaledDensity = metrics.density;
        Configuration config = new Configuration();
        config.densityDpi = DENSITY;
        // TV + dark: pick the resources a TV launcher would show
        config.uiMode = UI_MODE_TYPE_TELEVISION | UI_MODE_NIGHT_YES;
        return new Resources(assets, metrics, config);
    }

    private static Bitmap render(Resources res, int id, int width, int height) {
        Drawable d = res.getDrawableForDensity(id, DENSITY, null);
        if (width == 0) {
            width = d.getIntrinsicWidth();
            height = d.getIntrinsicHeight();
        }
        if (width <= 0 || height <= 0) {
            width = 320;
            height = 180;
        }
        float scale = Math.min(1f, (float) MAX_SIDE / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        d.setBounds(0, 0, width, height);
        d.draw(canvas);
        return bitmap;
    }

    private static void emit(String pkg, String kind, Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        System.out.println(pkg + "\t" + kind + "\t" + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
    }
}
