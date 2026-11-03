# dsh-voice: enumerate SAPI voices and report whether they are usable.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Result
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = New-Object System.Collections.ArrayList
  foreach ($v in $synth.GetInstalledVoices()) {
    $info = $v.VoiceInfo
    $null = $voices.Add([ordered]@{
      name    = $info.Name
      culture = [string]$info.Culture
      gender  = [string]$info.Gender
      enabled = [bool]$v.Enabled
    })
  }
  $default = ''
  try { $default = $synth.Voice.VoiceInfo.Name } catch { }
  $synth.Dispose()
  $payload = [ordered]@{
    ok      = $true
    default = $default
    voices  = @($voices)
    error   = ''
  }
}
catch {
  $payload = [ordered]@{
    ok      = $false
    default = ''
    voices  = @()
    error   = $_.Exception.Message
  }
}

[System.IO.File]::WriteAllText($Result, ($payload | ConvertTo-Json -Depth 5 -Compress), $Utf8)
exit 0
