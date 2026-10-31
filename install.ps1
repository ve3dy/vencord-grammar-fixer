param(
    [string] $VencordPath = $env:VENCORD_DIR,
    [switch] $SkipBuild,
    [switch] $Help
)

$ErrorActionPreference = "Stop"

function Show-Help {
    "Usage: powershell -ExecutionPolicy Bypass -File .\install.ps1 -VencordPath ""D:\Projects\Vencord"" [-SkipBuild]"
    ""
    "Options:"
    "  -VencordPath   Path to your Vencord checkout. Defaults to VENCORD_DIR when set."
    "  -SkipBuild     Copy files without running corepack pnpm build."
    "  -Help          Show this help."
}

function Resolve-VencordRoot([string] $Path) {
    if ($Path) {
        return (Resolve-Path -LiteralPath $Path).Path
    }

    if ((Test-Path -LiteralPath "package.json") -and (Test-Path -LiteralPath "src")) {
        return (Get-Location).Path
    }

    $enteredPath = Read-Host "Path to your Vencord checkout"
    if (!$enteredPath) {
        throw "Vencord path is required. Pass -VencordPath or set VENCORD_DIR."
    }

    return (Resolve-Path -LiteralPath $enteredPath).Path
}

if ($Help) {
    Show-Help
    exit 0
}

$source = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$vencordRoot = Resolve-VencordRoot $VencordPath
$packageJson = Join-Path $vencordRoot "package.json"
$srcDir = Join-Path $vencordRoot "src"
$userPluginsDir = Join-Path $srcDir "userplugins"
$target = Join-Path $userPluginsDir "grammarFixer"

if (!(Test-Path -LiteralPath $packageJson)) {
    throw "Not a Vencord checkout: missing package.json at $packageJson"
}

if (!(Test-Path -LiteralPath $srcDir)) {
    throw "Not a Vencord checkout: missing src directory at $srcDir"
}

if (!(Test-Path -LiteralPath $userPluginsDir)) {
    New-Item -ItemType Directory -Path $userPluginsDir | Out-Null
}

if (!(Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target | Out-Null
}

$sourcePath = (Resolve-Path -LiteralPath $source).Path.TrimEnd("\")
$targetPath = (Resolve-Path -LiteralPath $target).Path.TrimEnd("\")

if ($sourcePath -ine $targetPath) {
    # replace the whole folder so files removed from the plugin don't linger
    Get-ChildItem -LiteralPath $target -Force | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $source -Force | Where-Object Name -ne ".git" | Copy-Item -Destination $target -Recurse -Force
}

if (!$SkipBuild) {
    Push-Location $vencordRoot
    try {
        if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm build } else { corepack pnpm build }
    } finally {
        Pop-Location
    }
}

"Installed GrammarFixer to $target"
"Enable GrammarFixer in Vencord settings, then fully quit and restart Discord."
