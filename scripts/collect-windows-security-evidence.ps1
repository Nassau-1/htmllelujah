[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$ExecutablePath,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string]$UnpackedPath,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string]$PrivateEvidenceDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Convert-ToIsoUtc {
    param([Parameter(Mandatory = $true)][DateTime]$Value)
    return $Value.ToUniversalTime().ToString(
        'yyyy-MM-ddTHH:mm:ss.fffZ',
        [System.Globalization.CultureInfo]::InvariantCulture
    )
}

function Convert-ToOptionalIsoUtc {
    param($Value)
    if ($null -eq $Value) { return $null }
    return Convert-ToIsoUtc ([DateTime]$Value)
}

function Convert-ToOptionalVersion {
    param($Value)
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text
}

function Resolve-DefenderScanner {
    $platformRoot = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
    if (Test-Path -LiteralPath $platformRoot -PathType Container) {
        $candidate = Get-ChildItem -LiteralPath $platformRoot -Directory |
            Sort-Object { [version]($_.Name -replace '-.*$', '') } -Descending |
            ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }
    $fallback = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw 'Microsoft Defender command-line scanner was not found.'
}

function Get-DefenderStatusEvidence {
    $status = Get-MpComputerStatus
    return [ordered]@{
        antivirusEnabled = [bool]$status.AntivirusEnabled
        antispywareEnabled = [bool]$status.AntispywareEnabled
        amServiceEnabled = [bool]$status.AMServiceEnabled
        realTimeProtectionEnabled = [bool]$status.RealTimeProtectionEnabled
        engineVersion = [string]$status.AMEngineVersion
        platformVersion = [string]$status.AMProductVersion
        antivirusSignatureVersion = [string]$status.AntivirusSignatureVersion
        antivirusSignatureUpdatedAt = Convert-ToIsoUtc $status.AntivirusSignatureLastUpdated
        antispywareSignatureVersion = [string]$status.AntispywareSignatureVersion
        antispywareSignatureUpdatedAt = Convert-ToIsoUtc $status.AntispywareSignatureLastUpdated
        nisEngineVersion = Convert-ToOptionalVersion $status.NISEngineVersion
        nisSignatureVersion = Convert-ToOptionalVersion $status.NISSignatureVersion
        nisSignatureUpdatedAt = Convert-ToOptionalIsoUtc $status.NISSignatureLastUpdated
    }
}

function Get-UnsignedTargetEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return [ordered]@{
        role = $Role
        status = [string]$signature.Status
        signerCertificatePresent = $null -ne $signature.SignerCertificate
        timeStamperCertificatePresent = $null -ne $signature.TimeStamperCertificate
        signerSubject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
        timeStamperSubject = if ($signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Subject } else { $null }
    }
}

function Invoke-CleanCustomScan {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Scanner,
        [Parameter(Mandatory = $true)][string]$OutputDirectory
    )
    $started = [DateTime]::UtcNow
    $arguments = @('-Scan', '-ScanType', '3', '-File', $Path, '-DisableRemediation')
    $rawOutput = (& $Scanner @arguments 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    $completed = [DateTime]::UtcNow
    $outputBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($rawOutput)
    if ($outputBytes.Length -gt 10485760) {
        throw "Microsoft Defender output for $Role exceeded 10 MiB."
    }
    $logPath = Join-Path $OutputDirectory "$Role-defender-scan.log"
    [System.IO.File]::WriteAllBytes($logPath, $outputBytes)
    $logHash = Get-FileHash -LiteralPath $logPath -Algorithm SHA256
    $detections = @(
        Get-MpThreatDetection |
            Where-Object {
                $detected = $_.InitialDetectionTime
                $detected -and
                $detected.ToUniversalTime() -ge $started.AddSeconds(-1) -and
                $detected.ToUniversalTime() -le $completed.AddSeconds(1)
            }
    )
    return [ordered]@{
        targetRole = $Role
        scanType = 'custom'
        disableRemediation = $true
        exitCode = $exitCode
        signal = $null
        detectionCount = $detections.Count
        arguments = @(
            '-Scan'
            '-ScanType'
            '3'
            '-File'
            if ($Role -eq 'installer') { '<candidate-installer>' } else { '<candidate-win-unpacked>' }
            '-DisableRemediation'
        )
        outputSha256 = $logHash.Hash.ToLowerInvariant()
        outputBytes = [long]$outputBytes.Length
        startedAt = Convert-ToIsoUtc $started
        completedAt = Convert-ToIsoUtc $completed
    }
}

$statusEvidence = Get-DefenderStatusEvidence
$scannerPath = Resolve-DefenderScanner
$scannerFile = Get-Item -LiteralPath $scannerPath
$scannerHash = Get-FileHash -LiteralPath $scannerPath -Algorithm SHA256
$scannerSignature = Get-AuthenticodeSignature -LiteralPath $scannerPath
if (
    [string]$scannerSignature.Status -ne 'Valid' -or
    $null -eq $scannerSignature.SignerCertificate -or
    [string]$scannerSignature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'
) {
    throw 'Microsoft Defender scanner does not have a valid Microsoft Authenticode signature.'
}

$result = [ordered]@{
    status = $statusEvidence
    scanner = [ordered]@{
        sha256 = $scannerHash.Hash.ToLowerInvariant()
        size = [long]$scannerFile.Length
        version = [string]$scannerFile.VersionInfo.FileVersion
        authenticodeStatus = [string]$scannerSignature.Status
        signerCertificatePresent = $true
        signerSubject = [string]$scannerSignature.SignerCertificate.Subject
        signerThumbprint = [string]$scannerSignature.SignerCertificate.Thumbprint
    }
    signatures = @(
        Get-UnsignedTargetEvidence -Role 'installer' -Path $InstallerPath
        Get-UnsignedTargetEvidence -Role 'application-executable' -Path $ExecutablePath
    )
    scans = @(
        Invoke-CleanCustomScan -Role 'installer' -Path $InstallerPath -Scanner $scannerPath -OutputDirectory $PrivateEvidenceDirectory
        Invoke-CleanCustomScan -Role 'win-unpacked' -Path $UnpackedPath -Scanner $scannerPath -OutputDirectory $PrivateEvidenceDirectory
    )
}

$scannerAfter = Get-Item -LiteralPath $scannerPath
$scannerHashAfter = Get-FileHash -LiteralPath $scannerPath -Algorithm SHA256
$scannerSignatureAfter = Get-AuthenticodeSignature -LiteralPath $scannerPath
$statusEvidenceAfter = Get-DefenderStatusEvidence
if (
    $scannerHashAfter.Hash.ToLowerInvariant() -ne $result.scanner.sha256 -or
    [long]$scannerAfter.Length -ne $result.scanner.size -or
    [string]$scannerAfter.VersionInfo.FileVersion -ne $result.scanner.version -or
    [string]$scannerSignatureAfter.Status -ne $result.scanner.authenticodeStatus -or
    $null -eq $scannerSignatureAfter.SignerCertificate -or
    [string]$scannerSignatureAfter.SignerCertificate.Subject -ne $result.scanner.signerSubject -or
    [string]$scannerSignatureAfter.SignerCertificate.Thumbprint -ne $result.scanner.signerThumbprint
) {
    throw 'Microsoft Defender scanner identity changed during the candidate scans.'
}
if (
    ($statusEvidence | ConvertTo-Json -Depth 4 -Compress) -ne
    ($statusEvidenceAfter | ConvertTo-Json -Depth 4 -Compress)
) {
    throw 'Microsoft Defender engine, platform, protection, or signature state changed during the candidate scans.'
}

$result | ConvertTo-Json -Depth 8 -Compress
