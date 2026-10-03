$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = $taskRoot
$releaseRoot = Join-Path $taskRoot '.release'
$stageRoot = Join-Path (Join-Path $releaseRoot ([guid]::NewGuid().ToString())) 'local-cut'
$archivePath = Join-Path $taskRoot 'local-cut-source.zip'
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$rootFiles = @('package.json','package-lock.json','tsconfig.json','.prettierrc.json','.gitignore','LICENSE','README.md','VALIDATION.md','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','Start Editor.cmd','start-editor.sh','server.ts','media.ts','store.ts','composition.ts')
foreach ($name in $rootFiles) { Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $stageRoot $name) }
foreach ($directory in @('studio','web','tests','scripts','fixtures','.github')) {
  $base = Join-Path $sourceRoot $directory
  foreach ($file in Get-ChildItem -LiteralPath $base -File -Recurse -Force) {
    if ($file.Extension -notin @('.js','.ts','.css','.html','.json','.md','.yml','.ps1')) { continue }
    $relative = $file.FullName.Substring($sourceRoot.Length + 1)
    $target = Join-Path $stageRoot $relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target
  }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
[IO.Compression.ZipFile]::CreateFromDirectory([IO.Path]::GetDirectoryName($stageRoot),$archivePath)
Write-Output "Source archive: $archivePath"
Write-Output "Standalone verification folder: $stageRoot"
