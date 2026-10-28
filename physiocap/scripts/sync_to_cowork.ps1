# PhysioCap: keep a local copy in Documents\Cowork in sync with GitHub.
#
# First run (double-click sync_to_cowork.bat, or run with -Install):
#   1. checks that Git is installed (offers to install it with winget)
#   2. clones the repository into %USERPROFILE%\Documents\Cowork\PhysioCap
#   3. registers a per-user scheduled task "PhysioCap Sync" that pulls every 30 minutes and at logon
# Later runs (by the scheduled task): pull the latest commits (fast-forward only).
#
# Remove the automatic sync:  powershell -ExecutionPolicy Bypass -File sync_to_cowork.ps1 -Uninstall
param(
    [switch]$Install,
    [switch]$Uninstall,
    [string]$Branch = "ccr-8373bb47-hg1mx9",
    [int]$EveryMinutes = 30,
    [string]$RepoUrl = "https://github.com/gssim11/Metaverse-educational-game.git",
    [string]$CoworkDir = (Join-Path $env:USERPROFILE "Documents\Cowork")
)

$ErrorActionPreference = "Stop"
$Dest     = Join-Path $CoworkDir "PhysioCap"
$LogFile  = Join-Path $CoworkDir "PhysioCap_sync.log"
$TaskName = "PhysioCap Sync"
$SelfCopy = Join-Path $CoworkDir "sync_to_cowork.ps1"

$FallbackLog = Join-Path $env:LOCALAPPDATA "PhysioCap\PhysioCap_sync.log"

function Log([string]$msg) {
    # Logging must never stop the sync: if the Cowork folder cannot be written, log to %LOCALAPPDATA% instead.
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    foreach ($f in @($LogFile, $FallbackLog)) {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path $f) -ErrorAction Stop | Out-Null
            Add-Content -Path $f -Value $line -Encoding UTF8 -ErrorAction Stop
            return
        } catch { }
    }
}

function Test-Writable([string]$dir) {
    try {
        New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null
        $probe = Join-Path $dir (".physiocap_write_test_" + [guid]::NewGuid().ToString("N"))
        [IO.File]::WriteAllText($probe, "ok")
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch { return $false }
}

function Get-CfaEnabled {
    # Windows Security > Ransomware protection > Controlled folder access (1 = on, 2 = audit only).
    try { return ((Get-MpPreference -ErrorAction Stop).EnableControlledFolderAccess -eq 1) } catch { return $false }
}

function Get-AppsToAllow {
    $apps = @((Get-Command powershell.exe -ErrorAction SilentlyContinue).Source)
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) {
        # cmd\git.exe starts mingw64\bin\git.exe, which does the writing; HTTPS downloads go through git-remote-https.exe.
        $root = Split-Path (Split-Path $git)
        $apps += $git
        $apps += Get-ChildItem -Path $root -Recurse -Include git.exe, git-remote-https.exe -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName }
    }
    return $apps | Where-Object { $_ } | Sort-Object -Unique
}

function Resolve-Writable {
    if (Test-Writable $CoworkDir) { return }
    Write-Host ""
    Write-Host "[$CoworkDir] 폴더에 파일을 만들 수 없습니다."
    if (-not (Get-CfaEnabled)) {
        throw "Cannot write to $CoworkDir. Check that the folder exists and is not read-only, or run with -CoworkDir '<another folder>'."
    }
    Write-Host "원인: Windows 보안의 '제어된 폴더 액세스'(랜섬웨어 방지)가 문서 폴더 쓰기를 막고 있습니다."
    Write-Host "PowerShell과 Git만 허용 목록에 추가하면 됩니다(다른 설정은 바꾸지 않음):"
    $apps = Get-AppsToAllow
    $apps | ForEach-Object { Write-Host "   $_" }
    if (-not $Install) { throw "Controlled folder access blocks $CoworkDir. Run sync_to_cowork.bat once to allow PowerShell and Git." }
    $ans = Read-Host "관리자 권한으로 위 프로그램을 허용할까요? 다음 창에서 '예'를 누르세요 (Y/N)"
    if ($ans -notmatch '^[Yy]') {
        Write-Host "직접 하려면: Windows 보안 > 바이러스 및 위협 방지 > 랜섬웨어 방지 관리 > '제어된 폴더 액세스를 통해 앱 허용' > 앱 추가 > 최근에 차단된 앱에서 powershell.exe, git.exe 등을 허용"
        throw "Not allowed; nothing was changed."
    }
    $list = ($apps | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ","
    $cmd = "Add-MpPreference -ControlledFolderAccessAllowedApplications @($list)"
    try {
        Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command $cmd"
    } catch { throw "The administrator prompt was cancelled; nothing was changed." }
    Start-Sleep -Seconds 2
    if (-not (Test-Writable $CoworkDir)) {
        throw "Still blocked. Open Windows Security > Ransomware protection > Allow an app, and allow the apps under 'Recently blocked apps'."
    }
    Log "PowerShell and Git were allowed through Controlled folder access."
}

function Invoke-Git {
    # git writes progress to stderr; Windows PowerShell 5.1 would treat that as an error, so relax it here.
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & git @args 2>&1 | ForEach-Object { Log "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    return $code
}

function Ensure-Git {
    if (Get-Command git -ErrorAction SilentlyContinue) { return }
    if (-not $Install) { throw "Git is not installed." }
    Log "Git is not installed."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $ans = Read-Host "Install Git now with winget? (Y/N)"
        if ($ans -match '^[Yy]') {
            winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
            $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
        }
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git is still missing. Install it from https://git-scm.com/download/win and run this again."
    }
}

function Sync-Repo {
    if (-not (Test-Path (Join-Path $Dest ".git"))) {
        if ((Test-Path $Dest) -and (Get-ChildItem $Dest -Force | Select-Object -First 1)) {
            throw "$Dest exists and is not a git copy. Rename or empty it, then run again."
        }
        Log "Cloning $RepoUrl ($Branch) into $Dest"
        $code = Invoke-Git clone --branch $Branch $RepoUrl $Dest
        if ($code -ne 0) { throw "git clone failed (exit $code)." }
        return
    }
    Push-Location $Dest
    try {
        if ((Invoke-Git fetch --prune origin) -ne 0) {
            Log "Could not reach GitHub (offline?). Will try again next time."
            return
        }
        $current = (git rev-parse --abbrev-ref HEAD).Trim()
        $remote = git ls-remote --heads origin $current
        if (-not $remote) {
            # The branch is gone (for example after the pull request was merged): follow the default branch.
            # Read it from the ref itself; 'git remote show' prints translated text on non-English systems.
            $headRef = git ls-remote --symref origin HEAD | Where-Object { $_ -like "ref:*" } | Select-Object -First 1
            if (-not $headRef) { Log "Branch $current is gone and the default branch is unknown; nothing pulled."; return }
            $default = ($headRef -split "\s+")[1] -replace "^refs/heads/", ""
            Log "Branch $current no longer exists on GitHub; switching to $default."
            if ((Invoke-Git checkout $default) -ne 0) { Log "Could not switch to $default (local edits?)."; return }
        }
        $dirty = git status --porcelain --untracked-files=no
        if ($dirty) {
            Log "Not updated: these files were changed on this PC and are kept as they are:"
            $dirty | ForEach-Object { Log "   $_" }
            Log "To resume syncing, copy your edits elsewhere and run 'git checkout .' in $Dest."
            return
        }
        $before = git rev-parse HEAD
        if ((Invoke-Git pull --ff-only) -ne 0) { Log "Pull failed; see the lines above."; return }
        $after = git rev-parse HEAD
        if ($before -ne $after) { Log "Updated $($before.Substring(0,7)) -> $($after.Substring(0,7))" } else { Log "Already up to date ($($after.Substring(0,7)))." }
        # Keep the scheduled copy of this script current, so fixes pushed to GitHub reach this PC (used from the next run).
        $fresh = Join-Path $Dest "physiocap\scripts\sync_to_cowork.ps1"
        if ((Test-Path $fresh) -and (Test-Path $SelfCopy) -and
            ((Get-FileHash $fresh).Hash -ne (Get-FileHash $SelfCopy).Hash)) {
            Copy-Item -Path $fresh -Destination $SelfCopy -Force
            Log "Sync script updated from GitHub."
        }
    } finally { Pop-Location }
}

function Register-SyncTask {
    Copy-Item -Path $PSCommandPath -Destination $SelfCopy -Force
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SelfCopy`" -Branch $Branch -CoworkDir `"$CoworkDir`""
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $logon  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    $desc = "Pull PhysioCap updates from GitHub into Documents\Cowork\PhysioCap"
    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($repeat, $logon) `
            -Settings $settings -Description $desc -Force | Out-Null
        Log "Scheduled task '$TaskName' registered (every $EveryMinutes minutes and at logon)."
    } catch {
        # Some PCs allow the at-logon trigger only for administrators; keep the timer alone.
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $repeat `
            -Settings $settings -Description $desc -Force | Out-Null
        Log "Scheduled task '$TaskName' registered (every $EveryMinutes minutes)."
    }
}

try {
    if ($Uninstall) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Log "Scheduled task '$TaskName' removed. Files in $Dest were left as they are."
        exit 0
    }
    Ensure-Git
    Resolve-Writable
    Sync-Repo
    if ($Install) {
        Register-SyncTask
        Log "Done. Files are in $Dest. Log: $LogFile"
        Start-Process explorer.exe $Dest
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
    if ($Install) { Write-Host "Log: $LogFile (if missing: $FallbackLog)" }
    if ($Install) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}
