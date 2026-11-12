[CmdletBinding()]
param(
  [int]$Runs = 20,
  [int]$DelaySeconds = 8,
  # Leave slack beyond the 60-minute Finder window and finalization margin;
  # large candidate queues may legitimately take longer under shared quota.
  [int]$TimeoutSeconds = 3900,
  [ValidateRange(1, 64)]
  [int]$MaxProgressiveTotalGiChars = 16,
  # Optional availability gate for a fixed title already known to have Finder matches.
  [ValidateRange(0, 10000)]
  [int]$MinimumDeepbridFinderPlayableStreams = 0,
  [string]$TestType,
  [string]$TestId,
  [string]$TestLabel,
  [string]$Output = '.\aiostreams-scrape-results.json'
)

$ErrorActionPreference = 'Stop'

# The manifest path is a bearer credential. Read it via masked input instead of
# argv, environment variables, shell history, or report files.
$secureManifestUrl = Read-Host 'Enter the private AIOStreams manifest URL (input is masked)' -AsSecureString
$manifestBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureManifestUrl)
try {
  $ManifestUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($manifestBstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($manifestBstr)
  $secureManifestUrl.Dispose()
  $secureManifestUrl = $null
}
if ([string]::IsNullOrWhiteSpace($ManifestUrl)) { throw 'A manifest URL is required.' }

# Windows PowerShell 5.1 does not always preload HttpClient; progressive
# NDJSON scraping uses it directly, so load the framework assembly explicitly.
Add-Type -AssemblyName System.Net.Http
$Cinemeta = 'https://v3-cinemeta.strem.io'
$MaxProgressiveLineChars = 64 * 1024 * 1024
# Progressive snapshots are consumed one line at a time; cap cumulative
# decoded UTF-16 code units (not wire bytes) generously so large, long-running
# merges can finish without buffering the complete response in memory.
# TimeoutSeconds remains the primary bound. Override with
# -MaxProgressiveTotalGiChars when needed.
[long]$MaxProgressiveTotalChars = [long]$MaxProgressiveTotalGiChars * 1GB
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

function Get-RandomInt([int]$Max) {
  if ($Max -le 1) { return 0 }
  $bytes = New-Object byte[] 4
  $rng.GetBytes($bytes)
  return [Math]::Abs([BitConverter]::ToInt32($bytes, 0)) % $Max
}

function Invoke-Json([string]$Uri) {
  Start-Sleep -Milliseconds (500 + (Get-RandomInt 1200))
  return Invoke-RestMethod -Uri $Uri -Headers @{ 'User-Agent' = 'AIOStreams-scrape-tester/1.0' } -TimeoutSec $TimeoutSeconds
}

function Get-StreamSummary([object[]]$Streams) {
  $tagCounts = @{}
  $deepbridCount = 0
  $deepbridFinderTextCount = 0
  $deepbridFinderPlayableCount = 0
  $deepbridFinderExternalCount = 0
  $deepbridFinderNzbOnlyCount = 0
  $deepbridFinderSummaryCount = 0
  $deepbridFinderTaggedCount = 0
  $deepbridFinderNameCount = 0
  $deepbridFinderDescriptionCount = 0
  $deepbridCachedBadgeCount = 0
  $deepbridPendingBadgeCount = 0
  $deepbridUnspecifiedBadgeCount = 0
  $deepbridFinderIncompleteErrorCount = 0
  foreach ($stream in $Streams) {
    $name = [string]$stream.name
    $description = [string]$stream.description
    $finderText = "$name`n$description" -match '(?i)Deepbrid\s+Usenet'
    if (
      $name -match '(?i)Deepbrid\s+Usenet' -and
      $description -match '(?i)Deepbrid Finder resolution incomplete'
    ) {
      $deepbridFinderIncompleteErrorCount++
    }
    $isDeepbridFinderSummary = $finderText -and "$name`n$description" -match '(?i)Scrape\s+Summary'
    $hasDirectUrl = ![string]::IsNullOrWhiteSpace([string]$stream.url)
    $hasExternalUrl = ![string]::IsNullOrWhiteSpace([string]$stream.externalUrl)
    $hasNzbUrl = ![string]::IsNullOrWhiteSpace([string]$stream.nzbUrl)
    $isDeepbridFinder = $finderText -and !$isDeepbridFinderSummary -and $hasDirectUrl
    $isDeepbridFinderExternal = $finderText -and !$isDeepbridFinderSummary -and !$hasDirectUrl -and $hasExternalUrl
    $isDeepbridFinderNzbOnly = $finderText -and !$isDeepbridFinderSummary -and !$hasDirectUrl -and !$hasExternalUrl -and $hasNzbUrl
    if ($finderText) { $deepbridFinderTextCount++ }
    if ($isDeepbridFinder) { $deepbridFinderPlayableCount++ }
    if ($isDeepbridFinderExternal) { $deepbridFinderExternalCount++ }
    if ($isDeepbridFinderNzbOnly) { $deepbridFinderNzbOnlyCount++ }
    if ($isDeepbridFinderSummary) { $deepbridFinderSummaryCount++ }
    if ($name -match '(?i)Deepbrid\s+Usenet') { $deepbridFinderNameCount++ }
    if ($description -match '(?i)Deepbrid\s+Usenet') { $deepbridFinderDescriptionCount++ }

    # Match the badge independently from its Unicode glyph. Emoji may contain
    # variation selectors or surrogate pairs; neither should hide the service.
    $match = [regex]::Match($name, '^\[(?<tag>[A-Z0-9]+)(?<badge>[^\]]*)\]')
    $rawTag = if ($match.Success) { $match.Groups['tag'].Value } else { '' }
    # Only persist a fixed diagnostic category; source identifiers are untrusted.
    $tag = if ($rawTag -eq 'DB') { 'DB' } else { 'other' }
    if ($tag -eq 'DB') {
      $deepbridCount++
      if ($isDeepbridFinder) { $deepbridFinderTaggedCount++ }
      $badge = $match.Groups['badge'].Value
      if ($badge.Contains([char]0x26A1)) { $deepbridCachedBadgeCount++ }
      elseif ($badge.Contains([char]0x23F3)) { $deepbridPendingBadgeCount++ }
      else { $deepbridUnspecifiedBadgeCount++ }
    }
    if ($tagCounts.ContainsKey($tag)) { $tagCounts[$tag]++ } else { $tagCounts[$tag] = 1 }
  }
  return [pscustomobject]@{
    deepbridTaggedStreams = $deepbridCount
    deepbridFinderTextMatches = $deepbridFinderTextCount
    deepbridFinderPlayableStreams = $deepbridFinderPlayableCount
    deepbridFinderExternalDownloads = $deepbridFinderExternalCount
    deepbridFinderNzbOnlyStreams = $deepbridFinderNzbOnlyCount
    deepbridFinderSummaryCards = $deepbridFinderSummaryCount
    deepbridFinderTaggedStreams = $deepbridFinderTaggedCount
    deepbridFinderNameMatches = $deepbridFinderNameCount
    deepbridFinderDescriptionMatches = $deepbridFinderDescriptionCount
    deepbridOtherTaggedStreams = $deepbridCount - $deepbridFinderTaggedCount
    deepbridCachedBadgeStreams = $deepbridCachedBadgeCount
    deepbridPendingBadgeStreams = $deepbridPendingBadgeCount
    deepbridUnspecifiedBadgeStreams = $deepbridUnspecifiedBadgeCount
    deepbridFinderIncompleteErrors = $deepbridFinderIncompleteErrorCount
    streamsByTag = $tagCounts
  }
}

function Get-SafeErrorSummary([object[]]$Errors) {
  $categories = @{}
  $sources = @{}
  $errorItems = @($Errors | Where-Object { $null -ne $_ })
  foreach ($errorItem in $errorItems) {
    $title = [string]$errorItem.title
    $description = [string]$errorItem.description
    $category = if ($description -match '(?i)429|rate.?limit|too many requests') {
      'rate-limit'
    } elseif ($description -match '(?i)401|403|unauthori[sz]ed|forbidden') {
      'auth-or-permission'
    } elseif ($description -match '(?i)timeout|timed out|deadline') {
      'timeout'
    } elseif ($description -match '(?i)progressive addon response was interrupted') {
      'progressive-interrupted'
    } elseif ($description -match '(?i)abort|cancel') {
      'cancelled'
    } elseif ($description -match '(?i)socket|connect|dns|econn|reset|network') {
      'network'
    } else {
      'other'
    }
    if ($categories.ContainsKey($category)) { $categories[$category]++ } else { $categories[$category] = 1 }
    $source = if ($title -match '(?i)deepbrid\s+usenet') {
      'Deepbrid Usenet'
    } elseif ($title -match '(?i)newshosting') {
      'Newshosting'
    } elseif ($title -match '(?i)easynews') {
      'Easynews'
    } elseif ($title -match '(?i)unarr') {
      'UnArr'
    } else {
      'other'
    }
    if ($sources.ContainsKey($source)) { $sources[$source]++ } else { $sources[$source] = 1 }
  }
  return [pscustomobject]@{ count = $errorItems.Count; categories = $categories; sources = $sources }
}

function Reset-ScrapeRunDiagnostics {
  $script:progressiveFailureDiagnostics = $null
}

function Test-ScrapeRunsPassed(
  [object[]]$Results,
  [int]$ExpectedRuns,
  [int]$MinimumDeepbridFinderPlayableStreams = 0
) {
  if ($Results.Count -ne $ExpectedRuns) { return $false }
  foreach ($run in $Results) {
    if (!$run.runComplete -or $run.deepbridFinderIncompleteErrors -gt 0) {
      return $false
    }
    if (
      $MinimumDeepbridFinderPlayableStreams -gt 0 -and
      [int]$run.deepbridFinderPlayableStreams -lt $MinimumDeepbridFinderPlayableStreams
    ) { return $false }
    if ($run.errors -and $run.errors.count -gt 0) { return $false }
    if ($run.progressive -and (
      $run.progressiveTerminalEventCount -ne 1 -or
      $run.progressiveUnknownEventCount -gt 0 -or
      $run.progressiveEventsAfterTerminal -gt 0
    )) { return $false }
  }
  return $true
}

function Write-ScrapeReport(
  [string]$Json,
  [string]$Path,
  [string]$FallbackDirectory = [IO.Path]::GetTempPath()
) {
  $requestedPath = if ([IO.Path]::IsPathRooted($Path)) {
    $Path
  } else {
    Join-Path (Get-Location).Path $Path
  }

  try {
    [IO.File]::WriteAllText($requestedPath, $Json, [Text.UTF8Encoding]::new($false))
    return $requestedPath
  } catch {
    $primaryErrorType = $_.Exception.GetType().Name
    $fallbackPath = Join-Path $FallbackDirectory (
      'aiostreams-scrape-results-{0}-{1}-{2}.json' -f
        (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff'),
        $PID,
        [guid]::NewGuid().ToString('N')
    )

    try {
      # CreateNew prevents a fallback from overwriting an older report.
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
      $stream = [IO.File]::Open(
        $fallbackPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
      )
      try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
      return $fallbackPath
    } catch {
      throw ('Unable to save the sanitized scrape report to the requested path or temp fallback; primary error type: {0}.' -f $primaryErrorType)
    }
  }
}

function Get-ProgressiveEventKind($Event) {
  if ($Event.event -eq 'hello' -and $Event.version -eq 1) { return 'hello' }
  if ($Event.event -eq 'snapshot') { return 'snapshot' }
  if ($Event.event -eq 'complete') { return 'complete' }
  return 'unknown'
}

function Get-SafeProgressiveEventName($Event) {
  $name = [string]$Event.event
  if ($name -in @('hello', 'snapshot', 'complete', 'error', 'batch')) {
    return $name
  }
  return 'other'
}

function Get-SafeProgressiveEnvelopeShape($Event) {
  if ($null -eq $Event) { return 'null' }
  if ($Event -is [string]) { return 'json-string' }
  $properties = @($Event.PSObject.Properties.Name)
  if ($properties -contains 'event') {
    if ($properties -contains 'streams') { return 'event-with-streams' }
    if ($properties -contains 'error' -or $properties -contains 'message') { return 'event-with-error-details' }
    return 'event-only-or-metadata'
  }
  if ($properties -contains 'error' -or $properties -contains 'message') { return 'error-envelope' }
  if ($properties -contains 'streams') { return 'streams-envelope' }
  return 'object-other'
}

function Get-SafeProgressiveEnvelopeFlags($Event) {
  $properties = @($Event.PSObject.Properties.Name)
  return [pscustomobject]@{
    hasEvent = $properties -contains 'event'
    hasStreams = $properties -contains 'streams'
    hasErrors = $properties -contains 'errors'
    hasSuccess = $properties -contains 'success'
    hasData = $properties -contains 'data'
    hasError = $properties -contains 'error'
    hasMessage = $properties -contains 'message'
  }
}

function Get-SafeHttpRequestError($Exception) {
  $allowed = @(
    'NameResolutionError', 'ConnectionError', 'SecureConnectionError',
    'HttpProtocolError', 'ExtendedConnectNotSupported',
    'VersionNegotiationError', 'UserAuthenticationError',
    'ProxyTunnelError', 'InvalidResponse', 'ResponseEnded',
    'ConfigurationLimitExceeded', 'ResponseTooLarge',
    'RetryLimitExceeded', 'QueueFull', 'Unknown'
  )
  $current = $Exception
  for ($depth = 0; $current -and $depth -lt 6; $depth++) {
    $property = $current.PSObject.Properties['HttpRequestError']
    if ($property -and $null -ne $property.Value) {
      $value = [string]$property.Value
      if ($allowed -contains $value) { return $value }
    }
    $current = $current.InnerException
  }
  return $null
}

function Get-SafeFailureDiagnostic($ErrorRecord, [string]$Operation = '', [string]$FailureCode = '') {
  $category = 'unknown'
  if ($ErrorRecord -and $ErrorRecord.CategoryInfo -and
      $ErrorRecord.CategoryInfo.Category.ToString() -in @(
        'CloseError', 'DeviceError', 'InvalidArgument', 'InvalidData',
        'InvalidOperation', 'LimitsExceeded', 'NotSpecified', 'ObjectNotFound',
        'OperationStopped', 'OperationTimeout', 'ParserError', 'PermissionDenied',
        'ProtocolError', 'ReadError', 'ResourceBusy', 'ResourceUnavailable',
        'SecurityError', 'SyntaxError', 'ConnectionError', 'OpenError', 'WriteError'
      )) {
    $category = $ErrorRecord.CategoryInfo.Category.ToString()
  }

  $id = if ($ErrorRecord) { [string]$ErrorRecord.FullyQualifiedErrorId } else { '' }
  $failureClass = if ($FailureCode -eq 'line-limit') {
    'frame-size-limit'
  } elseif ($FailureCode -eq 'total-limit') {
    'total-size-limit'
  } elseif ($FailureCode -eq 'event-limit') {
    'event-count-limit'
  } elseif ($id -match '(?i)convertfrom-json|json') {
    'invalid-json'
  } elseif ($id -match '(?i)timeout|taskcanceled') {
    'timeout'
  } elseif ($id -match '(?i)http|socket|webexception|ioexception|readasync') {
    'transport-or-read'
  } elseif ($category -in @('ParserError', 'SyntaxError', 'InvalidData')) {
    'invalid-response'
  } elseif ($category -in @('ConnectionError', 'ProtocolError', 'ReadError', 'WriteError')) {
    'transport-or-read'
  } elseif ($category -eq 'OperationTimeout') {
    'timeout'
  } else {
    'other'
  }

  $command = 'other'
  $commandName = if ($ErrorRecord -and $ErrorRecord.InvocationInfo -and $ErrorRecord.InvocationInfo.MyCommand) {
    [string]$ErrorRecord.InvocationInfo.MyCommand.Name
  } else { '' }
  if ($commandName -in @('Read-ProgressiveLine', 'Invoke-ProgressiveStream', 'ConvertFrom-Json')) {
    $command = $commandName
  }
  $safeOperation = if ($Operation -in @('read-line', 'parse-json', 'classify-event', 'process-event')) { $Operation } else { 'other' }

  return [pscustomobject]@{
    class = $failureClass
    category = $category
    command = $command
    operation = $safeOperation
    line = if ($ErrorRecord -and $ErrorRecord.InvocationInfo) { [int]$ErrorRecord.InvocationInfo.ScriptLineNumber } else { 0 }
  }
}

function Get-SafeProgressiveExceptionType($Exception) {
  $known = @{
    'HttpRequestException' = 'http-request'
    'IOException' = 'io-read'
    'ObjectDisposedException' = 'disposed-reader'
    'TaskCanceledException' = 'task-cancelled'
    'TimeoutException' = 'timeout'
    'RuntimeException' = 'runtime'
    'FormatException' = 'format'
    'JsonReaderException' = 'json-reader'
  }
  $current = $Exception
  $fallback = 'other'
  for ($depth = 0; $current -and $depth -lt 6; $depth++) {
    $typeName = $current.GetType().Name
    if ($known.ContainsKey($typeName)) {
      $safeType = $known[$typeName]
      if ($safeType -ne 'runtime') { return $safeType }
      $fallback = 'runtime'
    }
    $current = $current.InnerException
  }
  return $fallback
}

function Read-ProgressiveLine($Reader, $State, [int]$TimeoutSeconds, [int]$MaxLineChars, [long]$MaxTotalChars) {
  if ($State.Queue.Count -gt 0) { return [pscustomobject]@{ hasLine = $true; line = $State.Queue.Dequeue() } }
  if ($State.Ended) { return [pscustomobject]@{ hasLine = $false; line = $null } }
  $chars = New-Object char[] 4096
  while ($State.Queue.Count -eq 0 -and !$State.Ended) {
    $remainingMs = ($TimeoutSeconds * 1000) - [int]$State.Stopwatch.ElapsedMilliseconds
    if ($remainingMs -le 0) { throw [System.TimeoutException]::new('Progressive response deadline exceeded.') }
    $readTask = $Reader.ReadAsync($chars, 0, $chars.Length)
    try {
      if (!$readTask.Wait($remainingMs)) {
        throw [System.TimeoutException]::new('Progressive response deadline exceeded.')
      }
      $read = $readTask.GetAwaiter().GetResult()
    } catch [System.TimeoutException] {
      throw [System.TimeoutException]::new('Progressive response deadline exceeded.')
    }
    if ($read -eq 0) {
      $State.Ended = $true
      if ($State.Line.Length -gt 0) {
        $State.Queue.Enqueue($State.Line.ToString())
        $State.Line.Clear() | Out-Null
      }
      break
    }
    $State.TotalChars += $read
    $nowElapsedMs = [int]$State.Stopwatch.ElapsedMilliseconds
    if ($null -ne $State.LastByteElapsedMs) {
      $gapMs = $nowElapsedMs - $State.LastByteElapsedMs
      if ($null -eq $State.MaxInterByteGapMs -or $gapMs -gt $State.MaxInterByteGapMs) {
        $State.MaxInterByteGapMs = $gapMs
      }
    }
    $State.LastByteElapsedMs = $nowElapsedMs
    if ($null -ne $script:progressiveFailureDiagnostics) {
      $script:progressiveFailureDiagnostics.lastByteElapsedMs = $State.LastByteElapsedMs
      $script:progressiveFailureDiagnostics.maxInterByteGapMs = $State.MaxInterByteGapMs
    }
    if ($State.TotalChars -gt $MaxTotalChars) {
      $State.FailureCode = 'total-limit'
      throw 'progressive-total-limit'
    }
    for ($index = 0; $index -lt $read; $index++) {
      if ($chars[$index] -eq "`n") {
        $line = $State.Line.ToString()
        $State.Line.Clear() | Out-Null
        if ($line.EndsWith("`r")) { $line = $line.Substring(0, $line.Length - 1) }
        $State.Queue.Enqueue($line)
      } else {
        [void]$State.Line.Append($chars[$index])
        if ($State.Line.Length -gt $State.LargestLineChars) {
          $State.LargestLineChars = $State.Line.Length
        }
        if ($State.Line.Length -gt $MaxLineChars) {
          $State.FailureCode = 'line-limit'
          throw 'progressive-frame-too-large'
        }
      }
    }
  }
  if ($State.Queue.Count -gt 0) { return [pscustomobject]@{ hasLine = $true; line = $State.Queue.Dequeue() } }
  return [pscustomobject]@{ hasLine = $false; line = $null }
}

function Invoke-ProgressiveStream([string]$Uri) {
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  $deadline = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
  $requestStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $script:progressiveFailureDiagnostics = [ordered]@{
    httpStatus = $null
    httpVersion = $null
    contentTypeCategory = 'unknown'
    eventCount = 0
    snapshotCount = 0
    terminalEventCount = 0
    readOutcome = 'pending'
    failureOperation = 'other'
    safeExceptionType = 'none'
    lastEventElapsedMs = $null
    lastByteElapsedMs = $null
    maxInterByteGapMs = 0
    elapsedMs = $null
    clientDeadlineExpired = $false
    transportRequestError = $null
    failureDiagnostic = $null
    totalCharsRead = 0
    largestLineChars = 0
    lastOperation = 'other'
  }
  $response = $null
  $reader = $null
    $httpStatus = $null
    $contentTypeCategory = 'unknown'
  try {
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('AIOStreams-scrape-tester/1.0')
    $response = $client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
    $httpStatus = [int]$response.StatusCode
    $script:progressiveFailureDiagnostics.httpStatus = $httpStatus
    $script:progressiveFailureDiagnostics.httpVersion = [string]$response.Version
    $contentType = [string]$response.Content.Headers.ContentType.MediaType
    $contentTypeCategory = if ($contentType -match '^application/(?:x-)?ndjson$') { 'ndjson' } elseif ($contentType -match '^(?:application|text)/json$') { 'json' } elseif ($contentType -match '^text/') { 'text' } else { 'other-or-missing' }
    $script:progressiveFailureDiagnostics.contentTypeCategory = $contentTypeCategory
    [void]$response.EnsureSuccessStatusCode()
    $body = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = [System.IO.StreamReader]::new($body, [System.Text.UTF8Encoding]::new($false, $true))
    $readerState = @{
      Queue = [System.Collections.Generic.Queue[string]]::new()
      Line = [System.Text.StringBuilder]::new()
      Stopwatch = $requestStopwatch
      Ended = $false
    TotalChars = [long]0
      LastByteElapsedMs = $null
      MaxInterByteGapMs = 0
      FailureCode = $null
    }
    $lastStreams = @()
    $lastErrors = @()
    $snapshotCount = 0
    $firstSnapshotMs = $null
    $deepbridFinderFirstSnapshotMs = $null
    $deepbridTaggedFirstSnapshotMs = $null
    $timeline = [System.Collections.Generic.List[object]]::new()
    $complete = $false
    $completeCount = 0
    $eventsAfterComplete = 0
    $unknownEventCount = 0
    $helloEventCount = 0
    $eventNameCounts = @{}
    $envelopeShapeCounts = @{}
    $envelopeFlags = $null
    $invalidCompletion = $false
    $eventCount = 0
    $timelineLimit = 512
    while ($true) {
      $script:progressiveFailureDiagnostics.lastOperation = 'read-line'
      $lineResult = Read-ProgressiveLine $reader $readerState $TimeoutSeconds $MaxProgressiveLineChars $MaxProgressiveTotalChars
      if (!$lineResult.hasLine) { break }
      $line = $lineResult.line
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $script:progressiveFailureDiagnostics.lastEventElapsedMs = [int]$requestStopwatch.ElapsedMilliseconds
      $script:progressiveFailureDiagnostics.lastOperation = 'parse-json'
      $event = $line | ConvertFrom-Json
      $eventCount++
      $script:progressiveFailureDiagnostics.eventCount = $eventCount
      if ($eventCount -gt 20000) {
        $readerState.FailureCode = 'event-limit'
        throw 'progressive-event-limit'
      }
      $script:progressiveFailureDiagnostics.lastOperation = 'classify-event'
      $safeEventName = Get-SafeProgressiveEventName $event
      if ($eventNameCounts.ContainsKey($safeEventName)) { $eventNameCounts[$safeEventName]++ } else { $eventNameCounts[$safeEventName] = 1 }
      $safeEnvelopeShape = Get-SafeProgressiveEnvelopeShape $event
      if ($envelopeShapeCounts.ContainsKey($safeEnvelopeShape)) { $envelopeShapeCounts[$safeEnvelopeShape]++ } else { $envelopeShapeCounts[$safeEnvelopeShape] = 1 }
      if ($null -eq $envelopeFlags) { $envelopeFlags = Get-SafeProgressiveEnvelopeFlags $event }
      if ($completeCount -gt 0) {
        $eventsAfterComplete++
        continue
      }
      $eventKind = Get-ProgressiveEventKind $event
      if ($eventKind -eq 'hello') {
        $helloEventCount++
      } elseif ($eventKind -eq 'snapshot') {
        $snapshotCount++
        $script:progressiveFailureDiagnostics.snapshotCount = $snapshotCount
        $eventStreams = @($event.streams)
        if ($null -eq $firstSnapshotMs) { $firstSnapshotMs = [int]$script:requestStopwatch.ElapsedMilliseconds }
        $eventSummary = Get-StreamSummary $eventStreams
        $eventElapsed = [int]$script:requestStopwatch.ElapsedMilliseconds
        if ($eventSummary.deepbridFinderPlayableStreams -gt 0 -and $null -eq $deepbridFinderFirstSnapshotMs) { $deepbridFinderFirstSnapshotMs = $eventElapsed }
        if ($eventSummary.deepbridTaggedStreams -gt 0 -and $null -eq $deepbridTaggedFirstSnapshotMs) { $deepbridTaggedFirstSnapshotMs = $eventElapsed }
        if ($timeline.Count -ge $timelineLimit) { $timeline.RemoveAt(0) }
        [void]$timeline.Add([pscustomobject]@{
          event = 'snapshot'
          elapsedMs = $eventElapsed
          streamCount = $eventStreams.Count
          deepbridFinderFirstSnapshotMs = $deepbridFinderFirstSnapshotMs
          deepbridTaggedFirstSnapshotMs = $deepbridTaggedFirstSnapshotMs
          deepbridTaggedStreams = $eventSummary.deepbridTaggedStreams
          deepbridFinderTextMatches = $eventSummary.deepbridFinderTextMatches
          deepbridFinderPlayableStreams = $eventSummary.deepbridFinderPlayableStreams
          deepbridFinderExternalDownloads = $eventSummary.deepbridFinderExternalDownloads
          deepbridFinderNzbOnlyStreams = $eventSummary.deepbridFinderNzbOnlyStreams
          deepbridFinderSummaryCards = $eventSummary.deepbridFinderSummaryCards
          deepbridFinderTaggedStreams = $eventSummary.deepbridFinderTaggedStreams
          deepbridFinderNameMatches = $eventSummary.deepbridFinderNameMatches
          deepbridFinderDescriptionMatches = $eventSummary.deepbridFinderDescriptionMatches
          deepbridOtherTaggedStreams = $eventSummary.deepbridOtherTaggedStreams
          deepbridCachedBadgeStreams = $eventSummary.deepbridCachedBadgeStreams
          deepbridPendingBadgeStreams = $eventSummary.deepbridPendingBadgeStreams
          deepbridUnspecifiedBadgeStreams = $eventSummary.deepbridUnspecifiedBadgeStreams
          streamsByTag = $eventSummary.streamsByTag
        })
        $lastStreams = $eventStreams
      } elseif ($eventKind -eq 'complete') {
        $completeCount++
        $script:progressiveFailureDiagnostics.terminalEventCount = $completeCount
        if ($null -eq $event.streams -or $event.streams -isnot [System.Array]) {
          $invalidCompletion = $true
        }
        $lastStreams = @($event.streams)
        $lastErrors = @($event.errors)
        $completeElapsed = [int]$script:requestStopwatch.ElapsedMilliseconds
        $completeSummary = Get-StreamSummary $lastStreams
        if ($completeSummary.deepbridFinderPlayableStreams -gt 0 -and $null -eq $deepbridFinderFirstSnapshotMs) { $deepbridFinderFirstSnapshotMs = $completeElapsed }
        if ($completeSummary.deepbridTaggedStreams -gt 0 -and $null -eq $deepbridTaggedFirstSnapshotMs) { $deepbridTaggedFirstSnapshotMs = $completeElapsed }
        if ($timeline.Count -ge $timelineLimit) { $timeline.RemoveAt(0) }
        [void]$timeline.Add([pscustomobject]@{
          event = 'complete'
          elapsedMs = $completeElapsed
          streamCount = $lastStreams.Count
          deepbridFinderFirstSnapshotMs = $deepbridFinderFirstSnapshotMs
          deepbridTaggedFirstSnapshotMs = $deepbridTaggedFirstSnapshotMs
          deepbridTaggedStreams = $completeSummary.deepbridTaggedStreams
          deepbridFinderTextMatches = $completeSummary.deepbridFinderTextMatches
          deepbridFinderPlayableStreams = $completeSummary.deepbridFinderPlayableStreams
          deepbridFinderExternalDownloads = $completeSummary.deepbridFinderExternalDownloads
          deepbridFinderNzbOnlyStreams = $completeSummary.deepbridFinderNzbOnlyStreams
          deepbridFinderSummaryCards = $completeSummary.deepbridFinderSummaryCards
          deepbridFinderTaggedStreams = $completeSummary.deepbridFinderTaggedStreams
          deepbridFinderNameMatches = $completeSummary.deepbridFinderNameMatches
          deepbridFinderDescriptionMatches = $completeSummary.deepbridFinderDescriptionMatches
          deepbridOtherTaggedStreams = $completeSummary.deepbridOtherTaggedStreams
          deepbridCachedBadgeStreams = $completeSummary.deepbridCachedBadgeStreams
          deepbridPendingBadgeStreams = $completeSummary.deepbridPendingBadgeStreams
          deepbridUnspecifiedBadgeStreams = $completeSummary.deepbridUnspecifiedBadgeStreams
      deepbridFinderIncompleteErrors = $completeSummary.deepbridFinderIncompleteErrors
          streamsByTag = $completeSummary.streamsByTag
        })
        $complete = $true
      } elseif ($eventKind -eq 'unknown') {
        $unknownEventCount++
      }
    }
    $terminalValid = $complete -and $completeCount -eq 1 -and
      $eventsAfterComplete -eq 0 -and !$invalidCompletion
    $script:progressiveFailureDiagnostics.readOutcome = if ($terminalValid) {
      'terminal-complete'
    } elseif ($readerState.Ended) {
      'clean-eof-before-terminal'
    } else {
      'ended-without-terminal'
    }
    return [pscustomobject]@{
      streams = $lastStreams
      errors = Get-SafeErrorSummary $lastErrors
      httpStatus = $httpStatus
      httpVersion = [string]$response.Version
      contentTypeCategory = $contentTypeCategory
      totalCharsRead = [long]$readerState.TotalChars
      largestLineChars = [int]$readerState.LargestLineChars
      lastEventElapsedMs = $script:progressiveFailureDiagnostics.lastEventElapsedMs
      lastByteElapsedMs = $script:progressiveFailureDiagnostics.lastByteElapsedMs
      maxInterByteGapMs = $script:progressiveFailureDiagnostics.maxInterByteGapMs
      snapshotCount = $snapshotCount
      firstSnapshotMs = $firstSnapshotMs
      deepbridFinderFirstSnapshotMs = $deepbridFinderFirstSnapshotMs
      deepbridTaggedFirstSnapshotMs = $deepbridTaggedFirstSnapshotMs
      deepbridFirstSnapshotMs = $deepbridTaggedFirstSnapshotMs
      finalEventReceived = $terminalValid
      readOutcome = $script:progressiveFailureDiagnostics.readOutcome
      terminalEventCount = $completeCount
      eventsAfterTerminal = $eventsAfterComplete
      helloEventCount = $helloEventCount
      unknownEventCount = $unknownEventCount
      eventNameCounts = $eventNameCounts
      envelopeShapeCounts = $envelopeShapeCounts
      envelopeFlags = $envelopeFlags
      timeline = @($timeline)
    }
  } catch {
    $script:progressiveFailureDiagnostics.elapsedMs = [int]$requestStopwatch.ElapsedMilliseconds
    $script:progressiveFailureDiagnostics.clientDeadlineExpired = $deadline.IsCancellationRequested
    $script:progressiveFailureDiagnostics.transportRequestError = Get-SafeHttpRequestError $_.Exception
    $script:progressiveFailureDiagnostics.failureDiagnostic = Get-SafeFailureDiagnostic $_ $script:progressiveFailureDiagnostics.lastOperation $readerState.FailureCode
    $script:progressiveFailureDiagnostics.failureOperation = if ($script:progressiveFailureDiagnostics.lastOperation -in @('read-line', 'parse-json', 'classify-event', 'process-event')) {
      $script:progressiveFailureDiagnostics.lastOperation
    } else { 'other' }
    $script:progressiveFailureDiagnostics.safeExceptionType = Get-SafeProgressiveExceptionType $_.Exception
    $script:progressiveFailureDiagnostics.readOutcome = if ($deadline.IsCancellationRequested) {
      'client-deadline'
    } elseif ($readerState.FailureCode -eq 'line-limit') {
      'frame-limit'
    } elseif ($readerState.FailureCode -eq 'total-limit') {
      'total-limit'
    } elseif ($readerState.FailureCode -eq 'event-limit') {
      'event-limit'
    } elseif ($script:progressiveFailureDiagnostics.lastOperation -eq 'read-line') {
      'read-exception'
    } elseif ($script:progressiveFailureDiagnostics.lastOperation -eq 'parse-json') {
      'parse-exception'
    } else {
      'event-processing-exception'
    }
    if ($readerState) {
      $script:progressiveFailureDiagnostics.totalCharsRead = [long]$readerState.TotalChars
      $script:progressiveFailureDiagnostics.largestLineChars = [int]$readerState.LargestLineChars
    }
    throw
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Dispose() }
    $deadline.Dispose()
    $client.Dispose()
  }
}

function Get-Catalog([string]$Path) {
  try { return (Invoke-Json "$Cinemeta/catalog/$Path.json").metas } catch { return @() }
}

function Get-SeriesEpisode($Meta) {
  $videos = @($Meta.videos | Where-Object {
    $season = 0
    $episode = 0
    [int]::TryParse([string]$_.season, [ref]$season) -and
      [int]::TryParse([string]$_.episode, [ref]$episode) -and
      $season -gt 0 -and
      $episode -gt 0
  })
  if (!$videos.Count) { return $null }
  return $videos[(Get-RandomInt $videos.Count)]
}

function Get-SeriesEpisodeTarget([string]$Value) {
  $match = [regex]::Match($Value, '^(?<seriesId>.+):(?<season>[0-9]+):(?<episode>[0-9]+)$')
  if (!$match.Success) { throw 'series-test-id-must-include-season-and-episode' }
  $season = [int]::Parse($match.Groups['season'].Value, [Globalization.CultureInfo]::InvariantCulture)
  $episode = [int]::Parse($match.Groups['episode'].Value, [Globalization.CultureInfo]::InvariantCulture)
  if ($season -lt 0 -or $episode -lt 1) { throw 'series-test-id-has-invalid-season-or-episode' }
  return [pscustomobject]@{ id = $Value; season = $season; episode = $episode }
}

$uri = [Uri]$ManifestUrl
$manifestPath = $uri.GetLeftPart([System.UriPartial]::Path)
$base = $manifestPath.Substring(0, $manifestPath.LastIndexOf('/manifest.json'))
$requestQuery = $uri.Query
$isProgressive = $requestQuery -match '(?:^|[?&])client=nuvio-progressive(?:&|$)'
if ([bool]$TestType -xor [bool]$TestId) { throw 'TestType and TestId must be supplied together.' }
if ($TestType -and $TestType -notin @('movie', 'series')) { throw 'TestType must be movie or series.' }
$testEpisodeTarget = if ($TestType -eq 'series') { Get-SeriesEpisodeTarget $TestId } else { $null }

$all = @()
$movies = @()
$series = @()
$anime = @()
$old = @()
$new = @()
$popular = @()
if (!$TestType) {
  $pool = @{}
  foreach ($path in @('series/top', 'series/popular', 'series/genre/Anime', 'movie/top', 'movie/popular')) {
    foreach ($meta in @(Get-Catalog $path)) { if ($meta.id) { $pool[$meta.id] = $meta } }
  }
  if (!$pool.Count) { throw 'Cinemeta returned no catalog entries.' }
  $all = @($pool.Values)
  $movies = @($all | Where-Object { $_.type -eq 'movie' })
  $series = @($all | Where-Object { $_.type -eq 'series' })
  $anime = @($series | Where-Object { $_.genres -contains 'Anime' -or $_.genres -contains 'Animation' })
  $old = @($all | Where-Object { [int]($_.year -as [int]) -and [int]$_.year -lt 2010 })
  $new = @($all | Where-Object { [int]($_.year -as [int]) -and [int]$_.year -ge 2020 })
  $popular = $all
}

$results = [System.Collections.Generic.List[object]]::new()
for ($i = 1; $i -le $Runs; $i++) {
  Reset-ScrapeRunDiagnostics
  if ($TestType) {
    $source = 'fixed'
    $picked = [pscustomobject]@{ type = $TestType; id = $TestId; name = if ($TestLabel) { $TestLabel } else { 'fixed-test' }; year = $null }
  } else {
    $bucket = Get-RandomInt 5
    $source = switch ($bucket) { 0 { 'popular' } 1 { 'old' } 2 { 'new' } 3 { 'anime' } default { 'movie' } }
    $choices = switch ($source) { 'old' { $old } 'new' { $new } 'anime' { $anime } 'movie' { $movies } default { $popular } }
    if (!$choices.Count) { $choices = $popular; $source = 'fallback' }
    $picked = $choices[(Get-RandomInt $choices.Count)]
  }
  try {
    $phase = 'metadata'
    $episode = $null
    if ($TestId) {
      if ($testEpisodeTarget) {
        $episode = $testEpisodeTarget
        $id = $testEpisodeTarget.id
      } else {
        $id = $TestId
      }
    } elseif ($picked.type -eq 'movie') {
      $id = $picked.id
    } else {
      $meta = Invoke-Json "$Cinemeta/meta/series/$([Uri]::EscapeDataString($picked.id)).json"
      $episode = Get-SeriesEpisode $meta.meta
      if (!$episode) { throw 'No usable episode metadata was returned.' }
      $id = "$($picked.id):$($episode.season):$($episode.episode)"
    }
    $encoded = [Uri]::EscapeDataString($id)
    $started = [System.Diagnostics.Stopwatch]::StartNew()
    $phase = 'stream'
    $progressiveDetails = $null
    $errorSummary = [pscustomobject]@{ count = 0; categories = @{}; sources = @{} }
    if ($isProgressive) {
      $streamUri = "$base/stream-progressive/$($picked.type)/$encoded.ndjson$requestQuery"
      $script:requestStopwatch = $started
      $progressiveDetails = Invoke-ProgressiveStream $streamUri
      $streams = @($progressiveDetails.streams)
      $errorSummary = $progressiveDetails.errors
    } else {
      $streamUri = "$base/stream/$($picked.type)/$encoded.json$requestQuery"
      $response = Invoke-Json $streamUri
      $streams = @($response.streams)
      $errorSummary = Get-SafeErrorSummary @($response.errors)
    }
    $streamSummary = Get-StreamSummary $streams
    $runComplete = !$isProgressive -or $progressiveDetails.finalEventReceived
    $results.Add([pscustomobject]@{
      run = $i; bucket = $source; type = $picked.type; title = '<redacted>'; year = $null
      imdb = '<redacted>'; season = if ($episode) { $episode.season } else { $null }; episode = if ($episode) { $episode.episode } else { $null }
      streamCountReturnedByAIOStreams = $streams.Count
      errors = $errorSummary
      deepbridTaggedStreams = $streamSummary.deepbridTaggedStreams
      deepbridFinderTextMatches = $streamSummary.deepbridFinderTextMatches
      deepbridFinderPlayableStreams = $streamSummary.deepbridFinderPlayableStreams
      deepbridFinderExternalDownloads = $streamSummary.deepbridFinderExternalDownloads
      deepbridFinderNzbOnlyStreams = $streamSummary.deepbridFinderNzbOnlyStreams
      deepbridFinderSummaryCards = $streamSummary.deepbridFinderSummaryCards
      deepbridFinderTaggedStreams = $streamSummary.deepbridFinderTaggedStreams
      deepbridFinderNameMatches = $streamSummary.deepbridFinderNameMatches
      deepbridFinderDescriptionMatches = $streamSummary.deepbridFinderDescriptionMatches
      deepbridOtherTaggedStreams = $streamSummary.deepbridOtherTaggedStreams
      deepbridCachedBadgeStreams = $streamSummary.deepbridCachedBadgeStreams
      deepbridPendingBadgeStreams = $streamSummary.deepbridPendingBadgeStreams
      deepbridUnspecifiedBadgeStreams = $streamSummary.deepbridUnspecifiedBadgeStreams
      deepbridFinderIncompleteErrors = $streamSummary.deepbridFinderIncompleteErrors
      streamsByTag = $streamSummary.streamsByTag
      progressive = $isProgressive
      progressiveSnapshots = $progressiveDetails.snapshotCount
      progressiveFirstSnapshotMs = $progressiveDetails.firstSnapshotMs
      progressiveFirstDeepbridMs = $progressiveDetails.deepbridFirstSnapshotMs
      progressiveFirstDeepbridFinderMs = $progressiveDetails.deepbridFinderFirstSnapshotMs
      progressiveFirstDeepbridTaggedMs = $progressiveDetails.deepbridTaggedFirstSnapshotMs
      progressiveFinalEventReceived = $progressiveDetails.finalEventReceived
      progressiveReadOutcome = $progressiveDetails.readOutcome
      progressiveTerminalEventCount = $progressiveDetails.terminalEventCount
      progressiveEventsAfterTerminal = $progressiveDetails.eventsAfterTerminal
      progressiveHelloEventCount = $progressiveDetails.helloEventCount
      progressiveUnknownEventCount = $progressiveDetails.unknownEventCount
      progressiveEventNameCounts = $progressiveDetails.eventNameCounts
      progressiveEnvelopeShapeCounts = $progressiveDetails.envelopeShapeCounts
      progressiveEnvelopeFlags = $progressiveDetails.envelopeFlags
      progressiveHttpStatus = $progressiveDetails.httpStatus
      progressiveHttpVersion = $progressiveDetails.httpVersion
      progressiveLastEventElapsedMs = $progressiveDetails.lastEventElapsedMs
      progressiveLastByteElapsedMs = $progressiveDetails.lastByteElapsedMs
      progressiveMaxInterByteGapMs = $progressiveDetails.maxInterByteGapMs
      progressiveContentTypeCategory = $progressiveDetails.contentTypeCategory
      progressiveCharsRead = $progressiveDetails.totalCharsRead
      progressiveLargestLineChars = $progressiveDetails.largestLineChars
      progressiveLineLimitChars = $MaxProgressiveLineChars
      progressiveTotalLimitChars = $MaxProgressiveTotalChars
      progressiveTimeline = $progressiveDetails.timeline
      runComplete = $runComplete
      elapsedMs = [int]$started.ElapsedMilliseconds
      testedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    })
    $progressLabel = if ($progressiveDetails) { "; snapshots=$($progressiveDetails.snapshotCount), first=$($progressiveDetails.firstSnapshotMs)ms, firstFinder=$($progressiveDetails.deepbridFinderFirstSnapshotMs)ms, firstDBTagged=$($progressiveDetails.deepbridTaggedFirstSnapshotMs)ms, terminal=$($progressiveDetails.finalEventReceived)" } else { '' }
    Write-Host ("[{0}/{1}] bucket={2} type={3} -> {4} streams{5}" -f $i,$Runs,$source,$picked.type,$streams.Count,$progressLabel)
  } catch {
    $failureCategory = if ($_.Exception -is [System.TimeoutException] -or $_.Exception.GetType().Name -match 'Timeout') {
      'timeout'
    } elseif ($_.Exception.GetType().Name -match 'HttpRequest|WebException|Socket') {
      'network'
    } elseif ($_.Exception.GetType().Name -match 'Json|Format') {
      'invalid-response'
    } else {
      'request-failed'
    }
    $exceptionChain = [System.Collections.Generic.List[string]]::new()
    $currentException = $_.Exception
    for ($depth = 0; $currentException -and $depth -lt 5; $depth++) {
      [void]$exceptionChain.Add($currentException.GetType().Name)
      $currentException = $currentException.InnerException
    }
    $results.Add([pscustomobject]@{
      run = $i
      bucket = $source
      type = $picked.type
      title = '[redacted]'
      year = $null
      imdb = '<redacted>'
      season = if ($testEpisodeTarget) { $testEpisodeTarget.season } else { $null }
      episode = if ($testEpisodeTarget) { $testEpisodeTarget.episode } else { $null }
      streamCountReturnedByAIOStreams = 0
      errors = [pscustomobject]@{ count = 0; categories = @{}; sources = @{} }
      deepbridTaggedStreams = 0
      deepbridFinderPlayableStreams = 0
      deepbridFinderIncompleteErrors = 0
      progressive = $isProgressive
      progressiveSnapshots = 0
      progressiveFinalEventReceived = $false
      progressiveTerminalEventCount = 0
      progressiveEventsAfterTerminal = 0
      progressiveHelloEventCount = 0
      progressiveUnknownEventCount = 0
      progressiveEventNameCounts = @{}
      progressiveEnvelopeShapeCounts = @{}
      progressiveEnvelopeFlags = $null
      progressiveHttpStatus = $null
      progressiveContentTypeCategory = $null
      progressiveEventsObservedBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.eventCount } else { 0 }
      progressiveSnapshotsObservedBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.snapshotCount } else { 0 }
      progressiveTerminalEventsObservedBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.terminalEventCount } else { 0 }
      progressiveHttpStatusBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.httpStatus } else { $null }
      progressiveHttpVersionBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.httpVersion } else { $null }
      progressiveContentTypeBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.contentTypeCategory } else { 'unknown' }
      progressiveLastEventElapsedMsBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.lastEventElapsedMs } else { $null }
      progressiveLastByteElapsedMsBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.lastByteElapsedMs } else { $null }
      progressiveMaxInterByteGapMsBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.maxInterByteGapMs } else { $null }
      progressiveFailureElapsedMs = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.elapsedMs } else { $null }
      progressiveClientDeadlineExpired = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.clientDeadlineExpired } else { $false }
      progressiveTransportRequestError = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.transportRequestError } else { $null }
      progressiveReadOutcome = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.readOutcome } else { 'other' }
      progressiveFailureOperation = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.failureOperation } else { 'other' }
      progressiveSafeExceptionType = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.safeExceptionType } else { 'other' }
      progressiveCharsReadBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.totalCharsRead } else { 0 }
      progressiveLargestLineCharsBeforeFailure = if ($script:progressiveFailureDiagnostics) { $script:progressiveFailureDiagnostics.largestLineChars } else { 0 }
      progressiveLineLimitChars = $MaxProgressiveLineChars
      runComplete = $false
      failurePhase = $phase
      failureCategory = $failureCategory
      # Keep enough failure telemetry to distinguish a local timeout from a
      # socket reset while never serializing exception text (which can contain
      # credentialed URLs or request details).
      failureExceptionType = $_.Exception.GetType().Name
      failureExceptionChain = @($exceptionChain)
      failureDiagnostic = if ($script:progressiveFailureDiagnostics -and $script:progressiveFailureDiagnostics.failureDiagnostic) {
        $script:progressiveFailureDiagnostics.failureDiagnostic
      } else { Get-SafeFailureDiagnostic $_ }
      elapsedMs = if ($started) { [int]$started.ElapsedMilliseconds } else { 0 }
      testedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    })
    Write-Warning ("[{0}/{1}] failed during {2}; category={3}" -f $i,$Runs,$phase,$failureCategory)
  }
  if ($i -lt $Runs) { Start-Sleep -Seconds ($DelaySeconds + (Get-RandomInt 5)) }
}

$completedRuns = @($results | Where-Object { $_.runComplete }).Count
$incompleteProgressiveRuns = @($results | Where-Object { $_.progressive -and !$_.progressiveFinalEventReceived }).Count
$incompleteFinderRuns = @($results | Where-Object { $_.progressive -and $_.deepbridFinderIncompleteErrors -gt 0 }).Count
$runsWithClientErrors = @($results | Where-Object { $_.errors -and $_.errors.count -gt 0 }).Count
$runsWithProgressiveProtocolAnomalies = @($results | Where-Object {
  $_.progressive -and (
    $_.progressiveTerminalEventCount -ne 1 -or
    $_.progressiveUnknownEventCount -gt 0 -or
    $_.progressiveEventsAfterTerminal -gt 0
  )
}).Count
$allRunsPassed = Test-ScrapeRunsPassed `
  -Results @($results) `
  -ExpectedRuns $Runs `
  -MinimumDeepbridFinderPlayableStreams $MinimumDeepbridFinderPlayableStreams
$summary = [pscustomobject]@{
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  manifestBase = '<redacted>'
  runsRequested = $Runs
  minimumDeepbridFinderPlayableStreams = $MinimumDeepbridFinderPlayableStreams
  runsRecorded = $results.Count
  runsCompleted = $completedRuns
  runsIncompleteProgressive = $incompleteProgressiveRuns
  runsWithIncompleteDeepbridFinder = $incompleteFinderRuns
  runsWithClientErrors = $runsWithClientErrors
  runsWithProgressiveProtocolAnomalies = $runsWithProgressiveProtocolAnomalies
  passed = $allRunsPassed
  testType = $TestType
  testId = if ($TestId) { '<redacted>' } else { $null }
  progressive = $isProgressive
  deduplication = 'AIOStreams server-side deduplication was not overridden; this report preserves every stream returned by the endpoint. Disable Deduplicator in the addon configuration for raw server results.'
  results = $results
}
$summaryJson = $summary | ConvertTo-Json -Depth 12
$savedReportPath = Write-ScrapeReport `
  -Json $summaryJson `
  -Path $Output
Write-Host "Saved $($results.Count) recorded runs ($completedRuns completed, $incompleteProgressiveRuns incomplete progressive) to $savedReportPath"
if (!$allRunsPassed) { exit 1 }
