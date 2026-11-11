# Render every slide of the Day 2 deck to a PNG with PowerPoint, to check how it really looks.
#   powershell -ExecutionPolicy Bypass -File deliverables\day2\render.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$deck = Join-Path $here "Team Maze - Al Ain University.pptx"
$out = Join-Path $here "rendered"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open($deck, $true, $false, $false)
  $pres.SaveAs($out, 18)
  "slides: " + $pres.Slides.Count
  $pres.Close()
} finally {
  $ppt.Quit()
}
Get-ChildItem $out | ForEach-Object { $_.Name }
