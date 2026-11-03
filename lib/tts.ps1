# dsh-voice: synthesize text to a WAV file with Windows SAPI (System.Speech).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [Parameter(Mandatory = $true)][string]$Wave,
  [Parameter(Mandatory = $true)][string]$Result
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Result {
  param([bool]$Ok, [hashtable]$Extra)
  $obj = [ordered]@{ ok = $Ok }
  if ($Extra) { foreach ($k in $Extra.Keys) { $obj[$k] = $Extra[$k] } }
  [System.IO.File]::WriteAllText($Result, ($obj | ConvertTo-Json -Compress), $Utf8)
}

try {
  $raw = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8)
  $req = $raw | ConvertFrom-Json
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voiceName = ''
  try {
    if ($req.voice) {
      try { $synth.SelectVoice([string]$req.voice) } catch { }
    }
    try { $voiceName = $synth.Voice.VoiceInfo.Name } catch { }

    $rate = 0
    if ($null -ne $req.rate) {
      $rate = [int][Math]::Max(-10, [Math]::Min(10, [double]$req.rate))
    }
    $synth.Rate = $rate

    $volume = 100
    if ($null -ne $req.volume) {
      $volume = [int][Math]::Max(0, [Math]::Min(100, [double]$req.volume))
    }
    $synth.Volume = $volume

    $synth.SetOutputToWaveFile($Wave)
    $synth.Speak([string]$req.text)
    $synth.Dispose()

    $bytes = (Get-Item -LiteralPath $Wave).Length
    Write-Result $true @{ voice = $voiceName; bytes = $bytes }
    exit 0
  }
  catch {
    try { $synth.Dispose() } catch { }
    Write-Result $false @{ error = $_.Exception.Message; voice = $voiceName }
    exit 1
  }
}
catch {
  Write-Result $false @{ error = $_.Exception.Message }
  exit 1
}
