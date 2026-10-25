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
    [int]$EveryMinutes = 30
)

$ErrorActionPreference = "Stop"
$RepoUrl  = "https://github.com/gssim11/Metaverse-educational-game.git"
$CoworkDir = Join-Path $env:USERPROFILE "Documents\Cowork"
$Dest     = Join-Path $CoworkDir "PhysioCap"
$LogFile  = Join-Path $CoworkDir "PhysioCap_sync.log"
$TaskName = "PhysioCap Sync"
$SelfCopy = Join-Path $CoworkDir "sync_to_cowork.ps1"

function Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    New-Item -ItemType Directory -Force -Path $CoworkDir | Out-Null
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
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
        $null = Invoke-Git fetch origin
        $remote = git ls-remote --heads origin $Branch
        if (-not $remote) {
            # The work branch is gone (for example after the pull request was merged): follow the default branch.
            $default = (git remote show origin | Select-String "HEAD branch").ToString().Split(":")[1].Trim()
            Log "Branch $Branch no longer exists on GitHub; switching to $default."
            $null = Invoke-Git checkout $default
        }
        $before = git rev-parse HEAD
        $code = Invoke-Git pull --ff-only
        if ($code -ne 0) {
            Log "Pull stopped: files in $Dest were changed locally. Local edits are kept; copy them elsewhere and run 'git checkout .' in that folder to resume syncing."
            return
        }
        $after = git rev-parse HEAD
        if ($before -ne $after) { Log "Updated $($before.Substring(0,7)) -> $($after.Substring(0,7))" } else { Log "Already up to date." }
    } finally { Pop-Location }
}

function Register-SyncTask {
    Copy-Item -Path $PSCommandPath -Destination $SelfCopy -Force
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SelfCopy`" -Branch $Branch"
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
    Sync-Repo
    if ($Install) {
        Register-SyncTask
        Log "Done. Files are in $Dest. Log: $LogFile"
        Start-Process explorer.exe $Dest
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
    if ($Install) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}
