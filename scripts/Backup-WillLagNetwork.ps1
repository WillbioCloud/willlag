<#
.SYNOPSIS
    Backup do estado de rede ANTES de qualquer otimização (não exige administrador).

.DESCRIPTION
    Grava três artefatos em %APPDATA%\willLag\standalone-backups\<timestamp>\ :

      1. willlag-network-backup.reg  - exportação nativa das chaves de registro
                                       relevantes (duplo clique restaura tudo).
      2. state.json                  - estado anterior em formato legível por
                                       máquina, INCLUSIVE "o valor não existia".
                                       É o que Restore-WillLagNetwork.ps1 usa
                                       para desfazer com precisão.
      3. netsh-dump.txt              - saída de netsh int tcp show global /
                                       supplemental / wlan show autoconfig, para
                                       conferência humana.

    O app (willLag) faz o mesmo backup internamente antes de cada alteração.
    Este script existe para quem quer um ponto de restauração manual, ou para
    recuperar a máquina se o app não estiver disponível.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Backup-WillLagNetwork.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Backup-WillLagNetwork.ps1 -Folder D:\backups\antes-do-jogo
#>

[CmdletBinding()]
param(
    [string]$Folder
)

$ErrorActionPreference = 'Continue'

$MM_PATH = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
$GAMES_PATH = "$MM_PATH\Tasks\Games"
$IFACE_ROOT = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
$QOS_PATH = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Psched'

$REG_KEYS_TO_EXPORT = @(
    'HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces',
    'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile',
    'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games',
    'HKLM\SOFTWARE\Policies\Microsoft\Windows\Psched'
)

function Read-RegValue([string]$path, [string]$name) {
    $item = Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    return $item.$name
}

# Registra o valor E se ele existia — restaurar "não existia" é diferente de
# restaurar 0, e é isso que permite desfazer com precisão.
function Capture-RegValue([string]$path, [string]$name) {
    $value = Read-RegValue $path $name
    if ($null -eq $value) {
        return [ordered]@{ existed = $false; value = $null }
    }
    if ($value -is [array]) { return [ordered]@{ existed = $true; value = @($value | ForEach-Object { "$_" }) } }
    return [ordered]@{ existed = $true; value = $value }
}

# ---------------------------------------------------------------------------
# Pasta de destino
# ---------------------------------------------------------------------------
if (-not $Folder) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $Folder = Join-Path $env:APPDATA ("willLag\standalone-backups\$stamp")
}

try {
    New-Item -ItemType Directory -Path $Folder -Force | Out-Null
} catch {
    Write-Host "[ERRO] Não foi possível criar a pasta de backup: $Folder" -ForegroundColor Red
    Write-Host "       $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "Backup em: $Folder" -ForegroundColor Cyan
$state = [ordered]@{
    version      = 1
    createdAt    = (Get-Date).ToString('o')
    computerName = $env:COMPUTERNAME
    windowsBuild = [int][Environment]::OSVersion.Version.Build
}

# ---------------------------------------------------------------------------
# 1) Exportação .reg nativa
# ---------------------------------------------------------------------------
$regFile = Join-Path $Folder 'willlag-network-backup.reg'
$exported = @()
foreach ($key in $REG_KEYS_TO_EXPORT) {
    if (Test-Path $key.Replace('HKLM\', 'HKLM:\')) {
        $partial = Join-Path $Folder ("part-{0}.reg" -f ($exported.Count + 1))
        & reg.exe export $key $partial /y 2>&1 | Out-Null
        if (Test-Path $partial) {
            $content = Get-Content $partial -Raw
            if ($exported.Count -eq 0) {
                Set-Content -Path $regFile -Value $content -Encoding Unicode
            } else {
                # Remove o cabeçalho "Windows Registry Editor Version 5.00" das partes seguintes.
                $body = ($content -split "`r?`n" | Where-Object { $_ -notmatch '^Windows Registry Editor' -and $_.Trim() }) -join "`r`n"
                Add-Content -Path $regFile -Value $body -Encoding Unicode
            }
            Remove-Item $partial -Force
            $exported += $key
        }
    }
}
$state.regExport = [ordered]@{ file = $regFile; keys = $exported }
Write-Host ("  [ok] {0} ({1} chaves)" -f (Split-Path $regFile -Leaf), $exported.Count) -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2) Estado detalhado em JSON
# ---------------------------------------------------------------------------

# --- Nagle, apenas interfaces com IP (as que o jogo realmente usa) ---
$nagle = @()
foreach ($k in @(Get-ChildItem $IFACE_ROOT -ErrorAction SilentlyContinue)) {
    $dhcpIp = Read-RegValue $k.PSPath 'DhcpIPAddress'
    $staticIp = Read-RegValue $k.PSPath 'IPAddress'

    $hasIp = $false
    if ($dhcpIp -and "$dhcpIp" -ne '0.0.0.0') { $hasIp = $true }
    if ($staticIp) { foreach ($s in @($staticIp)) { if ("$s" -ne '0.0.0.0' -and "$s" -ne '') { $hasIp = $true } } }
    if (-not $hasIp) { continue }

    $nagle += [ordered]@{
        guid    = $k.PSChildName
        regPath = "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($k.PSChildName)"
        values  = [ordered]@{
            TcpAckFrequency = Capture-RegValue $k.PSPath 'TcpAckFrequency'
            TCPNoDelay      = Capture-RegValue $k.PSPath 'TCPNoDelay'
            TcpDelAckTicks  = Capture-RegValue $k.PSPath 'TcpDelAckTicks'
        }
    }
}
$state.nagle = $nagle

# --- Multimedia SystemProfile ---
$state.systemProfile = [ordered]@{
    regPath = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
    values  = [ordered]@{
        NetworkThrottlingIndex = Capture-RegValue $MM_PATH 'NetworkThrottlingIndex'
        SystemResponsiveness   = Capture-RegValue $MM_PATH 'SystemResponsiveness'
    }
    games = [ordered]@{
        regPath = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games'
        values  = [ordered]@{
            'GPU Priority'        = Capture-RegValue $GAMES_PATH 'GPU Priority'
            'Priority'            = Capture-RegValue $GAMES_PATH 'Priority'
            'Scheduling Category' = Capture-RegValue $GAMES_PATH 'Scheduling Category'
            'SFIO Priority'       = Capture-RegValue $GAMES_PATH 'SFIO Priority'
        }
    }
}

# --- QoS / Psched ---
$state.qos = [ordered]@{
    regPath = 'HKLM\SOFTWARE\Policies\Microsoft\Windows\Psched'
    exists  = (Test-Path $QOS_PATH)
    values  = [ordered]@{ NonBestEffortLimit = Capture-RegValue $QOS_PATH 'NonBestEffortLimit' }
}

# --- netsh: TCP global e suplementar ---
$tcpRaw = (netsh int tcp show global 2>&1 | Out-String)
$supRaw = (netsh int tcp show supplemental 2>&1 | Out-String)
$state.netsh = [ordered]@{ globalRaw = $tcpRaw; supplementalRaw = $supRaw }

# Provedor de congestionamento atual do template Internet (o que o jogo usa).
$currentProvider = $null
$inInternet = $false
foreach ($line in ($supRaw -split "`r?`n")) {
    $t = $line.Trim()
    if ($t -match '^Internet\s*$') { $inInternet = $true; continue }
    if ($inInternet -and $t -match 'Congestion Control Provider\s*:\s*(\S+)') { $currentProvider = $matches[1].ToLower(); break }
    if ($inInternet -and $t -match '^(InternetCustom|Datacenter|DatacenterCustom|Compat)\b') { break }
}
if (-not $currentProvider -and $tcpRaw -match 'Congestion Control Provider\s*:\s*(\S+)') { $currentProvider = $matches[1].ToLower() }
$state.congestionProvider = [ordered]@{ template = 'Internet'; value = $currentProvider }

# --- WLAN AutoConfig ---
$acRaw = (netsh wlan show autoconfig 2>&1 | Out-String)
$autoconfig = @()
foreach ($line in ($acRaw -split "`r?`n")) {
    $t = $line.Trim()
    if ($t -match '^"([^"]+)"\s+auto configuration is\s+(enabled|disabled)') {
        $autoconfig += [ordered]@{ interface = $matches[1]; enabled = ($matches[2] -eq 'enabled') }
    } elseif ($t -match '(?:conexão|configuração)\s+automática[^:]*:\s*(ativado|desativado|habilitado|desabilitado)\s+(?:no|na)\s+(.+)$') {
        $on = ($matches[1] -match 'ativado|habilitado') -and ($matches[1] -notmatch 'desativado|desabilitado')
        $autoconfig += [ordered]@{ interface = $matches[2].Trim(); enabled = $on }
    }
}
$state.wlanAutoconfig = [ordered]@{ raw = $acRaw; interfaces = $autoconfig }

# --- USB Selective Suspend (AC/DC) ---
$pcRaw = (powercfg /q SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 2>&1 | Out-String)
$acIndex = $null; $dcIndex = $null
if ($pcRaw -match 'Current AC Power Setting Index\s*:\s*0x([0-9a-fA-F]+)') { $acIndex = [Convert]::ToInt32($matches[1], 16) }
elseif ($pcRaw -match '\(CA\)[^\r\n]*0x([0-9a-fA-F]+)') { $acIndex = [Convert]::ToInt32($matches[1], 16) }
if ($pcRaw -match 'Current DC Power Setting Index\s*:\s*0x([0-9a-fA-F]+)') { $dcIndex = [Convert]::ToInt32($matches[1], 16) }
elseif ($pcRaw -match '\(CC\)[^\r\n]*0x([0-9a-fA-F]+)') { $dcIndex = [Convert]::ToInt32($matches[1], 16) }
$state.usbSelectiveSuspend = [ordered]@{ ac = $acIndex; dc = $dcIndex }

# --- Energia dos adaptadores de rede ---
$adapterPower = @()
foreach ($a in @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)) {
    $pm = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction SilentlyContinue
    if (-not $pm) { continue }
    $adapterPower += [ordered]@{
        name    = $a.Name
        ifIndex = $a.ifIndex
        wasEnabled = [bool]($pm.AllowComputerToTurnOffDevice -eq 'Enabled')
    }
}
$state.adapterPower = $adapterPower

# --- DNS e MTU por interface conectada ---
$dnsList = @()
$mtuList = @()
foreach ($cfg in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) {
    $servers = @()
    foreach ($d in $cfg.DNSServer) {
        if ($d.AddressFamily -eq 2 -and $d.ServerAddresses) { $servers += @($d.ServerAddresses) }
    }
    $ipi = Get-NetIPInterface -InterfaceIndex $cfg.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
    $isDhcp = $false
    if ($ipi) { $isDhcp = ($ipi.Dhcp -eq 'Enabled') }

    $dnsList += [ordered]@{
        ifIndex  = $cfg.InterfaceIndex
        alias    = $cfg.InterfaceAlias
        servers  = $servers
        wasDhcp  = ($isDhcp -and $servers.Count -eq 0)
        dhcp     = if ($ipi) { $ipi.Dhcp } else { 'Unknown' }
    }

    if ($ipi) {
        $mtuList += [ordered]@{ ifIndex = $cfg.InterfaceIndex; alias = $cfg.InterfaceAlias; mtu = $ipi.NlMtu }
    }
}
$state.dns = $dnsList
$state.mtu = $mtuList

# ---------------------------------------------------------------------------
# Grava JSON + dump textual
# ---------------------------------------------------------------------------
$jsonFile = Join-Path $Folder 'state.json'
$state | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonFile -Encoding UTF8
Write-Host "  [ok] state.json" -ForegroundColor Green

$dumpFile = Join-Path $Folder 'netsh-dump.txt'
$dump = @()
$dump += "=== netsh int tcp show global ==="
$dump += $tcpRaw
$dump += "=== netsh int tcp show supplemental ==="
$dump += $supRaw
$dump += "=== netsh wlan show autoconfig ==="
$dump += $acRaw
$dump += "=== powercfg USB selective suspend ==="
$dump += $pcRaw
$dump -join "`r`n" | Set-Content -Path $dumpFile -Encoding UTF8
Write-Host "  [ok] netsh-dump.txt" -ForegroundColor Green

Write-Host ''
Write-Host ("Interfaces com IP capturadas para Nagle: {0}" -f $nagle.Count) -ForegroundColor Gray
Write-Host ("Interfaces com DNS capturadas          : {0}" -f $dnsList.Count) -ForegroundColor Gray
Write-Host ''
Write-Host 'Para desfazer alterações futuras:' -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -BackupFile '$jsonFile'" -ForegroundColor Green
Write-Host ''
