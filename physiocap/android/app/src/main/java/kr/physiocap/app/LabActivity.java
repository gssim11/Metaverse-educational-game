package kr.physiocap.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.text.InputType;
import android.util.Range;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.UUID;

/**
 * 연구실 모드: PhysioCap Lab 서버(GPU PC)의 지휘를 받아 2대 이상이 동시에 녹화하고 영상을 올린다.
 * OpenCap 촬영 조건에 맞춰 세로 720p, 초점 고정, 손떨림 보정 끔, 가능하면 60fps 로 녹화한다.
 * 같은 설정을 렌즈 보정(intrinsics) 캡처에도 쓰므로 보정값과 실제 촬영의 광학 조건이 같다.
 */
public class LabActivity extends Activity {
    private static final int REQ_CAM = 21;
    private static final float FOCUS_DIOPTERS = 0.3f; // 약 3.3 m 에 초점 고정 (렌즈 보정과 촬영에서 동일)
    private static final Size VIDEO_SIZE = new Size(1280, 720); // 센서 기준 가로 → 회전 90° = 세로 720×1280

    private TextureView preview;
    private TextView status;
    private EditText urlEdit, labelEdit;
    private SharedPreferences prefs;

    private HandlerThread camThread, netThread;
    private Handler camHandler, netHandler;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private CameraDevice camera;
    private CameraCaptureSession session;
    private String cameraId;
    private int fps = 30;
    private boolean fixedFocusSupported, oisAvailable;

    private MediaRecorder recorder;
    private File recFile;
    private long recStartDeviceMs;
    private JSONObject recCommand;
    private volatile boolean recording;

    private String server, deviceId;
    private volatile boolean polling;
    private long lastSeq;
    private double offsetMs; // 서버시각 - 기기시각
    private final ArrayDeque<double[]> offsetSamples = new ArrayDeque<>(); // {rtt, offset}
    private volatile String stateText = "idle", messageText = "";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("lab", MODE_PRIVATE);
        deviceId = prefs.getString("device_id", null);
        if (deviceId == null) {
            deviceId = UUID.randomUUID().toString();
            prefs.edit().putString("device_id", deviceId).apply();
        }
        buildUi();
        camThread = new HandlerThread("cam"); camThread.start(); camHandler = new Handler(camThread.getLooper());
        netThread = new HandlerThread("net"); netThread.start(); netHandler = new Handler(netThread.getLooper());
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
        }
    }

    // ---------------------------------------------------------------- 화면
    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        preview.addOnLayoutChangeListener((v, l, t, r, bt, ol, ot, or, ob) -> {
            int w = r - l, h = w * 16 / 9; // 9:16 세로 비율로 맞춤
            ViewGroup.LayoutParams lp = v.getLayoutParams();
            if (lp.height != h) { lp.height = h; v.setLayoutParams(lp); }
        });
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            public void onSurfaceTextureAvailable(SurfaceTexture s, int w, int h) { openCamera(); }
            public void onSurfaceTextureSizeChanged(SurfaceTexture s, int w, int h) { }
            public boolean onSurfaceTextureDestroyed(SurfaceTexture s) { return true; }
            public void onSurfaceTextureUpdated(SurfaceTexture s) { }
        });

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(24, 24, 24, 24);
        panel.setBackgroundColor(0xAA000000);
        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(15);
        status.setText("연구실 모드 — 서버 주소를 입력하거나 QR 을 스캔하세요");
        panel.addView(status);

        urlEdit = edit(prefs.getString("server", "http://192.168.0.10:8000"), InputType.TYPE_TEXT_VARIATION_URI);
        labelEdit = edit(prefs.getString("label", Build.MODEL + "-" + deviceId.substring(0, 4)), InputType.TYPE_CLASS_TEXT);
        panel.addView(labelEdit);
        panel.addView(urlEdit);
        LinearLayout row = new LinearLayout(this);
        Button scan = button("QR 스캔", v -> new IntentIntegrator(this).setPrompt("대시보드의 QR 을 비추세요").setBeepEnabled(false).setOrientationLocked(true).initiateScan());
        Button connect = button("연결", v -> connect());
        row.addView(scan); row.addView(connect);
        panel.addView(row);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        root.addView(panel, plp);
        setContentView(root);
    }

    private EditText edit(String val, int type) {
        EditText e = new EditText(this);
        e.setText(val);
        e.setTextColor(Color.WHITE);
        e.setHintTextColor(Color.GRAY);
        e.setInputType(type);
        e.setSingleLine(true);
        return e;
    }

    private Button button(String label, android.view.View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setOnClickListener(l);
        return b;
    }

    private void setStatus(String s) { ui.post(() -> status.setText(s)); }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        IntentResult r = IntentIntegrator.parseActivityResult(req, res, data);
        if (r != null && r.getContents() != null) {
            String c = r.getContents().trim();
            if (c.startsWith("physiocap-lab:")) c = c.substring("physiocap-lab:".length());
            urlEdit.setText(c);
            connect();
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_CAM && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && preview.isAvailable()) openCamera();
        else if (code == REQ_CAM) setStatus("카메라 권한이 필요합니다.");
    }

    // ---------------------------------------------------------------- 카메라
    private void openCamera() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED || camera != null) return;
        CameraManager cm = (CameraManager) getSystemService(CAMERA_SERVICE);
        try {
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics ch = cm.getCameraCharacteristics(id);
                Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) { cameraId = id; break; }
            }
            if (cameraId == null) { setStatus("후면 카메라를 찾지 못했습니다."); return; }
            CameraCharacteristics ch = cm.getCameraCharacteristics(cameraId);
            fps = 30;
            Range<Integer>[] ranges = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (ranges != null) for (Range<Integer> r : ranges) if (r.getLower() == 60 && r.getUpper() == 60) fps = 60;
            Float minFocus = ch.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
            fixedFocusSupported = minFocus != null && minFocus > 0f;
            int[] ois = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION);
            oisAvailable = ois != null && ois.length > 1;
            cm.openCamera(cameraId, new CameraDevice.StateCallback() {
                public void onOpened(CameraDevice c) { camera = c; startPreview(); }
                public void onDisconnected(CameraDevice c) { c.close(); camera = null; }
                public void onError(CameraDevice c, int e) { c.close(); camera = null; setStatus("카메라 오류 " + e); }
            }, camHandler);
        } catch (CameraAccessException | SecurityException e) {
            setStatus("카메라를 열 수 없습니다: " + e.getMessage());
        }
    }

    private Surface previewSurface() {
        SurfaceTexture st = preview.getSurfaceTexture();
        st.setDefaultBufferSize(VIDEO_SIZE.getWidth(), VIDEO_SIZE.getHeight());
        return new Surface(st);
    }

    private void applyCaptureSettings(CaptureRequest.Builder rb) {
        rb.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, new Range<>(fps, fps));
        rb.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);
        if (oisAvailable) rb.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF);
        if (fixedFocusSupported) {
            rb.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
            rb.set(CaptureRequest.LENS_FOCUS_DISTANCE, FOCUS_DIOPTERS);
        }
        if (Build.VERSION.SDK_INT >= 30) rb.set(CaptureRequest.CONTROL_ZOOM_RATIO, 1.0f);
    }

    private void startPreview() {
        if (camera == null || !preview.isAvailable()) return;
        try {
            Surface ps = previewSurface();
            CaptureRequest.Builder rb = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            rb.addTarget(ps);
            applyCaptureSettings(rb);
            camera.createCaptureSession(Arrays.asList(ps), new CameraCaptureSession.StateCallback() {
                public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    try { s.setRepeatingRequest(rb.build(), null, camHandler); } catch (Exception e) { setStatus("미리보기 실패: " + e.getMessage()); }
                }
                public void onConfigureFailed(CameraCaptureSession s) { setStatus("미리보기 구성 실패"); }
            }, camHandler);
        } catch (Exception e) {
            setStatus("미리보기 실패: " + e.getMessage());
        }
    }

    private void startRecording(JSONObject cmd) {
        camHandler.post(() -> {
            if (camera == null || recording) return;
            try {
                if (session != null) { session.close(); session = null; }
                recFile = new File(getExternalFilesDir(null), "lab_" + System.currentTimeMillis() + ".mp4");
                recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
                recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
                recorder.setVideoSize(VIDEO_SIZE.getWidth(), VIDEO_SIZE.getHeight());
                recorder.setVideoFrameRate(fps);
                recorder.setVideoEncodingBitRate(fps >= 60 ? 16_000_000 : 10_000_000);
                recorder.setOrientationHint(90); // 세로로 세운 폰
                recorder.setOutputFile(recFile.getAbsolutePath());
                recorder.prepare();
                Surface rs = recorder.getSurface();
                Surface ps = previewSurface();
                CaptureRequest.Builder rb = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                rb.addTarget(ps);
                rb.addTarget(rs);
                applyCaptureSettings(rb);
                camera.createCaptureSession(Arrays.asList(ps, rs), new CameraCaptureSession.StateCallback() {
                    public void onConfigured(CameraCaptureSession s) {
                        session = s;
                        try {
                            s.setRepeatingRequest(rb.build(), null, camHandler);
                            recorder.start();
                            recStartDeviceMs = System.currentTimeMillis();
                            recording = true;
                            recCommand = cmd;
                            stateText = "recording";
                            setStatus("● 녹화 중 (" + fps + "fps, 초점 " + (fixedFocusSupported ? "고정" : "고정 불가 기종") + ")");
                        } catch (Exception e) { setStatus("녹화 시작 실패: " + e.getMessage()); }
                    }
                    public void onConfigureFailed(CameraCaptureSession s) { setStatus("녹화 구성 실패"); }
                }, camHandler);
            } catch (Exception e) {
                setStatus("녹화 준비 실패: " + e.getMessage());
            }
        });
    }

    private void stopRecording() {
        camHandler.post(() -> {
            if (!recording) return;
            recording = false;
            try { recorder.stop(); } catch (Exception e) { setStatus("녹화 정지 오류: " + e.getMessage()); }
            recorder.release();
            recorder = null;
            if (session != null) { session.close(); session = null; }
            startPreview();
            final File f = recFile;
            final JSONObject cmd = recCommand;
            final long start = recStartDeviceMs;
            netHandler.post(() -> upload(f, cmd, start));
        });
    }

    // ---------------------------------------------------------------- 서버 통신
    private void connect() {
        server = urlEdit.getText().toString().trim().replaceAll("/+$", "");
        prefs.edit().putString("server", server).putString("label", labelEdit.getText().toString().trim()).apply();
        netHandler.post(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("device_id", deviceId);
                body.put("label", labelEdit.getText().toString().trim());
                body.put("model", Build.MODEL);
                body.put("width", VIDEO_SIZE.getHeight());   // 세로 기준
                body.put("height", VIDEO_SIZE.getWidth());
                body.put("fps", fps);
                http("POST", "/api/devices/register", body.toString());
                setStatus("서버 연결됨 — 대시보드에서 녹화를 시작하세요 (" + fps + "fps)");
                if (!polling) { polling = true; netHandler.post(this::pollOnce); }
            } catch (Exception e) {
                setStatus("연결 실패: " + e.getMessage() + "\n같은 Wi-Fi 인지, 주소가 맞는지 확인하세요.");
            }
        });
    }

    private void pollOnce() {
        if (!polling) return;
        try {
            String q = "/api/devices/" + deviceId + "/poll?offset_ms=" + offsetMs
                    + "&state=" + URLEncoder.encode(stateText, "UTF-8")
                    + "&message=" + URLEncoder.encode(messageText, "UTF-8");
            long t0 = System.currentTimeMillis();
            JSONObject r = new JSONObject(http("GET", q, null));
            long t1 = System.currentTimeMillis();
            updateOffset(r.getDouble("server_ms") - (t0 + t1) / 2.0, t1 - t0);
            if (!r.isNull("command")) {
                JSONObject cmd = r.getJSONObject("command");
                long seq = cmd.optLong("seq");
                if (seq > lastSeq) { lastSeq = seq; handle(cmd); }
            }
        } catch (Exception e) {
            setStatus("서버 응답 없음: " + e.getMessage());
        }
        netHandler.postDelayed(this::pollOnce, 500);
    }

    /** 왕복시간이 가장 짧았던 측정값의 시계 차이를 쓴다(NTP 방식). */
    private void updateOffset(double offset, long rtt) {
        offsetSamples.addLast(new double[]{rtt, offset});
        while (offsetSamples.size() > 20) offsetSamples.removeFirst();
        double best = Double.MAX_VALUE;
        for (double[] s : offsetSamples) if (s[0] < best) { best = s[0]; offsetMs = s[1]; }
    }

    private void handle(JSONObject cmd) {
        String action = cmd.optString("action");
        if ("record".equals(action)) {
            long startServer = cmd.optLong("start_at_server_ms");
            long delay = Math.max(0, (long) (startServer - offsetMs - System.currentTimeMillis()));
            String what = "intrinsics".equals(cmd.optString("purpose")) ? "렌즈 보정 캡처" : cmd.optString("trial") + " (" + cmd.optString("cam") + ")";
            setStatus("곧 녹화 시작: " + what);
            ui.postDelayed(() -> startRecording(cmd), delay);
        } else if ("stop".equals(action)) {
            stopRecording();
        }
    }

    private void upload(File f, JSONObject cmd, long startDeviceMs) {
        stateText = "uploading";
        setStatus("업로드 중… " + (f.length() / 1_000_000) + " MB");
        String boundary = "----physiocap" + System.nanoTime();
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/upload").openConnection();
            c.setDoOutput(true);
            c.setRequestMethod("POST");
            c.setChunkedStreamingMode(1 << 16);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(600_000);
            c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            try (DataOutputStream out = new DataOutputStream(c.getOutputStream())) {
                field(out, boundary, "device_id", deviceId);
                field(out, boundary, "purpose", cmd.optString("purpose", "trial"));
                field(out, boundary, "session", cmd.optString("session"));
                field(out, boundary, "trial", cmd.optString("trial"));
                field(out, boundary, "cam", cmd.optString("cam"));
                field(out, boundary, "capture_id", cmd.optString("capture_id"));
                field(out, boundary, "start_device_ms", String.valueOf(startDeviceMs));
                field(out, boundary, "fps", String.valueOf(fps));
                out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + f.getName() + "\"\r\nContent-Type: video/mp4\r\n\r\n");
                try (InputStream in = new FileInputStream(f)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                out.writeBytes("\r\n--" + boundary + "--\r\n");
            }
            int code = c.getResponseCode();
            if (code / 100 != 2) throw new RuntimeException("HTTP " + code);
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            stateText = "idle";
            messageText = "";
            setStatus("업로드 완료 — 다음 녹화를 기다립니다");
        } catch (Exception e) {
            stateText = "error";
            messageText = "업로드 실패: " + e.getMessage();
            setStatus(messageText + " (파일은 폰에 남아 있음: " + f.getName() + ")");
        }
    }

    private static void field(DataOutputStream out, String boundary, String name, String value) throws Exception {
        out.writeBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.writeBytes("\r\n");
    }

    private String http(String method, String path, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(server + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(4000);
        c.setReadTimeout(6000);
        if (json != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        InputStream in = code / 100 == 2 ? c.getInputStream() : c.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (in != null) try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        if (code / 100 != 2) throw new RuntimeException("HTTP " + code + " " + sb);
        return sb.toString();
    }

    @Override
    protected void onDestroy() {
        polling = false;
        if (recording) stopRecording();
        camHandler.post(() -> {
            if (session != null) session.close();
            if (camera != null) camera.close();
        });
        camThread.quitSafely();
        netThread.quitSafely();
        super.onDestroy();
    }
}
