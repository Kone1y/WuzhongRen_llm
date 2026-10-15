package com.mist.wanderer;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.OnApplyWindowInsetsListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightNavigationBars(false);

        View contentView = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(contentView, new OnApplyWindowInsetsListener() {
            @Override
            public WindowInsetsCompat onApplyWindowInsets(View v, WindowInsetsCompat insets) {
                // 状态栏 + 导航栏 + IME（软键盘）：全部转为内容内边距。
                // Android 15 edge-to-edge 下 adjustResize 失效，键盘高度要在这里手动应用；
                // 应用 padding 后 WebView 整体上移，输入框自然露在键盘上方。
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                int top = Math.max(bars.top, 0);
                int bottom = Math.max(Math.max(bars.bottom, ime.bottom), 0);
                v.setPadding(bars.left, top, bars.right, bottom);
                return WindowInsetsCompat.CONSUMED;
            }
        });
    }
}
