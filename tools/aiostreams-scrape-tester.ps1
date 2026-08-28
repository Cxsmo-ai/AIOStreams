[CmdletBinding()]
param(
  [string]$ManifestUrl = 'https://a1y18df.deepascension.net/stremio/cfb3663b-97b9-4fd3-9128-1eeb86b81a2b/eyJpIjoiczM3QVFVQTQyOGJjVk1QWnRoamVqdz09IiwiZSI6IkpmdjFBSUJVWm0wdVBSM2JjRm9SMXc9PSIsInQiOiJhIn0/manifest.json',
  [int]$Runs = 20,
  [int]$DelaySeconds = 8,
  [string]$Output = '.\aiostreams-scrape-results.json'
)

$ErrorActionPreference = 'Stop'
$Cinemeta = 'https://v3-cinemeta.strem.io'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

function Get-RandomInt([int]$Max) {
  if ($Max -le 1) { return 0 }
  $bytes = New-Object byte[] 4
  $rng.GetBytes($bytes)
  return [Math]::Abs([BitConverter]::ToInt32($bytes, 0)) % $Max
}

function Invoke-Json([string]$Uri) {
  Start-Sleep -Milliseconds (500 + (Get-RandomInt 1200))
  return Invoke-RestMethod -Uri $Uri -Headers @{ 'User-Agent' = 'AIOStreams-scrape-tester/1.0' } -TimeoutSec 45
}

function Get-Catalog([string]$Path) {
  try { return (Invoke-Json "$Cinemeta/catalog/$Path.json").metas } catch { return @() }
}

function Get-SeriesEpisode($Meta) {
  $videos = @($Meta.videos | Where-Object { $_.season -is [int] -and $_.episode -is [int] -and $_.season -gt 0 -and $_.episode -gt 0 })
  if (!$videos.Count) { return $null }
  return $videos[(Get-RandomInt $videos.Count)]
}

$uri = [Uri]$ManifestUrl
$base = $ManifestUrl.Substring(0, $ManifestUrl.LastIndexOf('/manifest.json'))
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

$results = [System.Collections.Generic.List[object]]::new()
for ($i = 1; $i -le $Runs; $i++) {
  $bucket = Get-RandomInt 5
  $source = switch ($bucket) { 0 { 'popular' } 1 { 'old' } 2 { 'new' } 3 { 'anime' } default { 'movie' } }
  $choices = switch ($source) { 'old' { $old } 'new' { $new } 'anime' { $anime } 'movie' { $movies } default { $popular } }
  if (!$choices.Count) { $choices = $popular; $source = 'fallback' }
  $picked = $choices[(Get-RandomInt $choices.Count)]
  try {
    $episode = $null
    if ($picked.type -eq 'movie') {
      $id = $picked.id
    } else {
      $meta = Invoke-Json "$Cinemeta/meta/series/$([Uri]::EscapeDataString($picked.id)).json"
      $episode = Get-SeriesEpisode $meta.meta
      if (!$episode) { continue }
      $id = "$($picked.id):$($episode.season):$($episode.episode)"
    }
    $encoded = [Uri]::EscapeDataString($id)
    $started = Get-Date
    $response = Invoke-Json "$base/stream/series/$encoded.json"
    $streams = @($response.streams)
    $bySource = @{}
    foreach ($stream in $streams) {
      $name = [string]$stream.name
      $key = if ($name -match '\] ([^ ]+)') { $Matches[1] } else { 'unknown' }
      if ($bySource.ContainsKey($key)) { $bySource[$key]++ } else { $bySource[$key] = 1 }
    }
    $results.Add([pscustomobject]@{
      run = $i; bucket = $source; type = $picked.type; title = $picked.name; year = $picked.year
      imdb = $picked.id; season = if ($episode) { $episode.season } else { $null }; episode = if ($episode) { $episode.episode } else { $null }
      streamCountReturnedByAIOStreams = $streams.Count
      addonsObserved = ($bySource.Keys | Sort-Object)
      streamsByAddon = $bySource
      elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
      testedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    })
    $label = if ($episode) { "S$($episode.season.ToString('00'))E$($episode.episode.ToString('00'))" } else { 'movie' }
    Write-Host ("[{0}/{1}] {2} {3} -> {4} streams" -f $i,$Runs,$picked.name,$label,$streams.Count)
  } catch { Write-Warning ("[{0}/{1}] failed for {2}: {3}" -f $i,$Runs,$picked.name,$_.Exception.Message) }
  if ($i -lt $Runs) { Start-Sleep -Seconds ($DelaySeconds + (Get-RandomInt 5)) }
}

$summary = [pscustomobject]@{
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  manifestBase = $base
  runsRequested = $Runs
  runsCompleted = $results.Count
  deduplication = 'AIOStreams server-side deduplication was not overridden; this report preserves every stream returned by the endpoint. Disable Deduplicator in the addon configuration for raw server results.'
  results = $results
}
$summary | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -Path $Output
Write-Host "Saved $($results.Count) completed runs to $Output"
