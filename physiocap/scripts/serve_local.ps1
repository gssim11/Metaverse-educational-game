# PhysioCap: serve the web app from this PC and open it in the browser.
# Browsers do not run the app (ES modules, camera) from a double-clicked file://, so this starts a tiny
# web server on http://localhost using only Windows PowerShell (nothing to install). Close the window to stop it.
param([int]$Port = 8080)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\web")).Path
$Types = @{
    ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".mjs" = "text/javascript; charset=utf-8"
    ".css" = "text/css; charset=utf-8"; ".json" = "application/json"; ".webmanifest" = "application/manifest+json"
    ".wasm" = "application/wasm"; ".svg" = "image/svg+xml"; ".png" = "image/png"; ".ico" = "image/x-icon"
    ".task" = "application/octet-stream"; ".tflite" = "application/octet-stream"; ".txt" = "text/plain; charset=utf-8"
}

$listener = $null
foreach ($p in $Port..($Port + 20)) {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    try { $l.Start(); $listener = $l; $Port = $p; break } catch { $l.Close() }
}
if (-not $listener) { Write-Host "No free port between $Port and $($Port + 20)."; Read-Host "Press Enter to close" | Out-Null; exit 1 }

$url = "http://localhost:$Port/"
Write-Host "PhysioCap is running at $url"
Write-Host "Folder: $Root"
Write-Host "Keep this window open while you use the app. Close it to stop."
if ($env:PHYSIOCAP_NO_BROWSER -ne "1") { Start-Process $url }

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $res = $ctx.Response
        try {
            $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/").Replace("/", [IO.Path]::DirectorySeparatorChar)
            $file = [IO.Path]::GetFullPath((Join-Path $Root $rel))
            if (-not $file.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { $res.StatusCode = 403; continue }
            if (Test-Path $file -PathType Container) { $file = Join-Path $file "index.html" }
            if (-not (Test-Path $file -PathType Leaf)) { $res.StatusCode = 404; continue }
            $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
            $res.ContentType = if ($Types.ContainsKey($ext)) { $Types[$ext] } else { "application/octet-stream" }
            $res.Headers["Cache-Control"] = "no-cache"
            $fs = [IO.File]::OpenRead($file)
            try { $res.ContentLength64 = $fs.Length; $fs.CopyTo($res.OutputStream) } finally { $fs.Dispose() }
        } catch {
            try { $res.StatusCode = 500 } catch { }
        } finally {
            try { $res.Close() } catch { }
        }
    }
} finally { $listener.Stop(); $listener.Close() }
