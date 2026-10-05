<#
.SYNOPSIS
    Relatório somente-leitura do estado de rede/latência do Windows.

.DESCRIPTION
    Mostra EXATAMENTE o que o willLag lê antes de alterar qualquer coisa:
      - versão/build do Windows e se ele é moderno (>= 9200)
      - adaptadores, qual é o preferido (menor métrica de rota) e se é Wi-Fi USB
      - parâmetros globais de TCP e provedores de congestionamento suportados
      - valores de Nagle nas interfaces com IP
      - NetworkThrottlingIndex / SystemResponsiveness / tarefa MMCSS "Games"
      - estado do WLAN AutoConfig (varredura de redes em segundo plano)
      - USB Selective Suspend (AC/DC) e energia do adaptador
      - DNS em uso, MTU e política QoS (Psched)

    NADA é alterado e não exige administrador.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Get-WillLagReport.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Get-WillLagReport.ps1 -Json
#>

[CmdletBinding()]
param(
    [switch]$Json
)

$ErrorActionPreference = 'SilentlyContinue'
$script:Report = [ordered]@{}

function Write-Section([string]$title) {
    if ($Json) { return }
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor DarkCyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ('=' * 70) -ForegroundColor DarkCyan
}

function Write-Row([string]$label, $value, [string]$note) {
    if ($Json) { return }
    if ($null -eq $value -or "$value" -eq '') { $value = '-' }
    $text = '  {0,-40} {1}' -f $label, $value
    if ($note) { $text += "   -> $note" }
    Write-Host $text
}

function Write-Raw([string]$text) {
    if ($Json) { return }
    foreach ($line in ($text -split "`r?`n")) {
        if ($line.Trim()) { Write-Host "  $line" -ForegroundColor DarkGray }
    }
}

function Read-RegValue([string]$path, [string]$name) {
    $item = Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    return $item.$name
}

function Get-UsbSuspendIndex([string]$raw, [string]$acDc, [string]$ptTag) {
    if ($raw -match "Current $acDc Power Setting Index\s*:\s*0x([0-9a-fA-F]+)") { return [Convert]::ToInt32($matches[1], 16) }
    if ($raw -match "\($ptTag\)[^\r\n]*0x([0-9a-fA-F]+)") { return [Convert]::ToInt32($matches[1], 16) }
    return $null
}

# ---------------------------------------------------------------------------
# Sistema
# ---------------------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
$build = [int][Environment]::OSVersion.Version.Build
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$script:Report.system = [ordered]@{
    caption      = $os.Caption
    build        = $build
    isModern     = ($build -ge 9200)
    isAdmin      = $isAdmin
    computerName = $env:COMPUTERNAME
}

Write-Section 'Sistema'
Write-Row 'Windows' $os.Caption
Write-Row 'Build' $build $(if ($build -ge 9200) { 'moderno: chimney/timestamps são legado' } else { 'legado' })
Write-Row 'Administrador' $isAdmin $(if (-not $isAdmin) { 'os scripts de alteração exigem elevação' } else { $null })

# ---------------------------------------------------------------------------
# Adaptadores e rota preferida
# ---------------------------------------------------------------------------
Write-Section 'Adaptadores de rede'

$adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)
$ipConfigs = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)

$preferred = $null
$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
            Sort-Object { [int]$_.RouteMetric + [int]$_.ifMetric })
if ($routes.Count -gt 0) { $preferred = $routes[0] }

$adapterList = @()
foreach ($a in $adapters) {
    $cfg = $null
    foreach ($c in $ipConfigs) { if ($c.InterfaceIndex -eq $a.ifIndex) { $cfg = $c; break } }

    $isWifi = ($a.PhysicalMediaType -match '802\.11|Wireless') -or ($a.MediaType -match '802\.11|Wireless') -or ($a.Name -match 'Wi-?Fi|Wireless|WLAN')
    $isUsb = [bool]($a.PnPDeviceID -match '^USB\\')

    $ipv4 = $null
    $gateway = $null
    $dnsServers = @()
    $mtu = $null
    if ($cfg) {
        if ($cfg.IPv4Address) { $ipv4 = $cfg.IPv4Address.IPAddress }
        if ($cfg.IPv4DefaultGateway) { $gateway = $cfg.IPv4DefaultGateway.NextHop }
        foreach ($d in $cfg.DNSServer) {
            if ($d.AddressFamily -eq 2 -and $d.ServerAddresses) { $dnsServers += @($d.ServerAddresses) }
        }
        $ipi = Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ipi) { $mtu = $ipi.NlMtu }
    }

    $entry = [ordered]@{
        name        = $a.Name
        description = $a.InterfaceDescription
        ifIndex     = $a.ifIndex
        status      = $a.Status
        linkSpeed   = $a.LinkSpeed
        mac         = $a.MacAddress
        isWifi      = [bool]$isWifi
        isUsb       = $isUsb
        ipv4        = $ipv4
        gateway     = $gateway
        dns         = $dnsServers
        mtu         = $mtu
    }
    $adapterList += $entry

    Write-Row $entry.name ("[{0}] {1}" -f $entry.status, $entry.description)
    Write-Row '    IPv4 / gateway' ("{0} / {1}" -f $ipv4, $gateway)
    Write-Row '    MTU' $mtu
    $tag = $null
    if ($isWifi -and $isUsb) { $tag = 'dongle Wi-Fi USB: sujeito a lag spike de varredura e suspensão' }
    elseif ($isWifi) { $tag = 'Wi-Fi interno' }
    Write-Row '    Wi-Fi / USB' ("wifi={0} usb={1}" -f [bool]$isWifi, $isUsb) $tag
    Write-Row '    DNS' $(if ($dnsServers.Count) { $dnsServers -join ', ' } else { '(DHCP / nenhum)' })
}

$script:Report.adapters = $adapterList
if ($preferred) {
    $script:Report.preferredInterface = [ordered]@{
        ifIndex     = $preferred.ifIndex
        routeMetric = $preferred.RouteMetric
        ifMetric    = $preferred.ifMetric
        nextHop     = $preferred.NextHop
    }
    Write-Row 'Interface preferida (rota padrão)' ("ifIndex {0} via {1}" -f $preferred.ifIndex, $preferred.NextHop)
} else {
    $script:Report.preferredInterface = $null
    Write-Row 'Interface preferida (rota padrão)' '(nenhuma rota 0.0.0.0/0)'
}

# ---------------------------------------------------------------------------
# TCP global
# ---------------------------------------------------------------------------
Write-Section 'Parâmetros globais de TCP (netsh int tcp show global)'
$tcpRaw = (netsh int tcp show global 2>&1 | Out-String)
$script:Report.tcpGlobalRaw = $tcpRaw
Write-Raw $tcpRaw

$supRaw = (netsh int tcp show supplemental 2>&1 | Out-String)
$script:Report.tcpSupplementalRaw = $supRaw
Write-Host ''
Write-Row 'supplemental (provedores por template)' ''
Write-Raw $supRaw

$supported = @()
foreach ($p in @('ctcp', 'cubic', 'compound', 'newreno', 'bbr')) {
    if ($supRaw -match "\b$p\b") { $supported += $p }
}
$script:Report.congestionProvidersSupported = $supported
Write-Row 'Provedores detectados' $(if ($supported.Count) { $supported -join ', ' } else { 'nenhum' }) 'só estes podem ser definidos'

# ---------------------------------------------------------------------------
# Nagle por interface
# ---------------------------------------------------------------------------
Write-Section 'Nagle (Tcpip\Parameters\Interfaces)'
$ifaceRoot = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
$nagle = @()
foreach ($k in @(Get-ChildItem $ifaceRoot -ErrorAction SilentlyContinue)) {
    $dhcpIp = Read-RegValue $k.PSPath 'DhcpIPAddress'
    $staticIp = Read-RegValue $k.PSPath 'IPAddress'

    $hasIp = $false
    if ($dhcpIp -and "$dhcpIp" -ne '0.0.0.0') { $hasIp = $true }
    if ($staticIp) {
        foreach ($s in @($staticIp)) { if ("$s" -ne '0.0.0.0' -and "$s" -ne '') { $hasIp = $true } }
    }
    if (-not $hasIp) { continue }

    $ackFreq = Read-RegValue $k.PSPath 'TcpAckFrequency'
    $noDelay = Read-RegValue $k.PSPath 'TCPNoDelay'
    $delAck = Read-RegValue $k.PSPath 'TcpDelAckTicks'

    $entry = [ordered]@{
        guid            = $k.PSChildName
        dhcpIPAddress   = $dhcpIp
        tcpAckFrequency = $ackFreq
        tcpNoDelay      = $noDelay
        tcpDelAckTicks  = $delAck
    }
    $nagle += $entry

    $note = 'padrão do Windows (Nagle ativo)'
    if ($ackFreq -eq 1 -and $noDelay -eq 1) { $note = 'Nagle DESATIVADO' }
    Write-Row $entry.guid ("AckFreq={0} NoDelay={1} DelAckTicks={2}" -f $ackFreq, $noDelay, $delAck) $note
}
$script:Report.nagle = $nagle
if ($nagle.Count -eq 0) { Write-Row '(nenhuma interface com IP)' '-' }

# ---------------------------------------------------------------------------
# Multimedia SystemProfile
# ---------------------------------------------------------------------------
Write-Section 'Multimedia SystemProfile (throttling, responsividade, MMCSS Games)'
$mmPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
$gamesPath = "$mmPath\Tasks\Games"

$nti = Read-RegValue $mmPath 'NetworkThrottlingIndex'
$sr = Read-RegValue $mmPath 'SystemResponsiveness'
$gpuPriority = Read-RegValue $gamesPath 'GPU Priority'
$priority = Read-RegValue $gamesPath 'Priority'
$schedCat = Read-RegValue $gamesPath 'Scheduling Category'
$sfio = Read-RegValue $gamesPath 'SFIO Priority'

$ntiHex = $null
if ($null -ne $nti) { $ntiHex = '0x{0:x8}' -f [uint32]$nti }

$script:Report.systemProfile = [ordered]@{
    networkThrottlingIndex    = $nti
    networkThrottlingIndexHex = $ntiHex
    systemResponsiveness      = $sr
    games = [ordered]@{
        gpuPriority        = $gpuPriority
        priority           = $priority
        schedulingCategory = $schedCat
        sfioPriority       = $sfio
    }
}

Write-Row 'NetworkThrottlingIndex' $ntiHex $(if ($ntiHex -eq '0xffffffff') { 'throttling DESATIVADO' } else { 'padrão 0x0000000a (10 pacotes/ms)' })
Write-Row 'SystemResponsiveness' $sr $(if ($sr -eq 0) { '100% para o jogo' } else { 'padrão 20 (20% reservado)' })
Write-Row 'Games / GPU Priority' $gpuPriority 'padrão 1, willLag usa 8'
Write-Row 'Games / Priority' $priority 'padrão 1, willLag usa 6'
Write-Row 'Games / Scheduling Category' $schedCat 'padrão Medium, willLag usa High'
Write-Row 'Games / SFIO Priority' $sfio 'padrão Normal, willLag usa High'

# ---------------------------------------------------------------------------
# WLAN AutoConfig (varredura em segundo plano)
# ---------------------------------------------------------------------------
Write-Section 'WLAN AutoConfig (varredura de redes em segundo plano)'
$wlanRaw = (netsh wlan show interfaces 2>&1 | Out-String)
$script:Report.wlanRaw = $wlanRaw
Write-Raw $wlanRaw

$svc = Get-Service WlanSvc -ErrorAction SilentlyContinue
if ($svc) {
    $script:Report.wlanService = [ordered]@{ name = $svc.Name; status = $svc.Status.ToString(); startType = $svc.StartType.ToString() }
    Write-Row 'Serviço WlanSvc' ("{0} ({1})" -f $svc.Status, $svc.StartType) 'precisa estar rodando para mexer em autoconfig'
} else {
    $script:Report.wlanService = $null
    Write-Row 'Serviço WlanSvc' '(ausente)' 'sem rádio Wi-Fi neste PC'
}

$acRaw = (netsh wlan show autoconfig 2>&1 | Out-String)
$script:Report.autoconfigRaw = $acRaw
Write-Raw $acRaw

# ---------------------------------------------------------------------------
# Energia: USB Selective Suspend e adaptador de rede
# ---------------------------------------------------------------------------
Write-Section 'Energia (USB Selective Suspend e adaptador de rede)'
$usbSubgroup = '2a737441-1930-4402-8d77-b2bebba308a3'
$usbSetting = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'
$pcRaw = (powercfg /q SCHEME_CURRENT $usbSubgroup $usbSetting 2>&1 | Out-String)

$ac = Get-UsbSuspendIndex -raw $pcRaw -acDc 'AC' -ptTag 'CA'
$dc = Get-UsbSuspendIndex -raw $pcRaw -acDc 'DC' -ptTag 'CC'
$script:Report.usbSelectiveSuspend = [ordered]@{ ac = $ac; dc = $dc }

Write-Row 'USB Selective Suspend (AC)' $ac $(if ($ac -eq 0) { 'desativado' } else { 'ATIVADO: pode derrubar dongle Wi-Fi ocioso' })
Write-Row 'USB Selective Suspend (DC)' $dc $(if ($dc -eq 0) { 'desativado' } else { 'ativado' })

$pmList = @()
foreach ($a in $adapters) {
    $pm = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction SilentlyContinue
    if (-not $pm) { continue }

    $turnOff = if ($pm.AllowComputerToTurnOffDevice) { $pm.AllowComputerToTurnOffDevice.ToString() } else { 'n/d' }
    $sleepDisc = if ($pm.DeviceSleepOnDisconnect) { $pm.DeviceSleepOnDisconnect.ToString() } else { 'n/d' }
    $selSusp = if ($pm.SelectiveSuspend) { $pm.SelectiveSuspend.ToString() } else { 'n/d' }
    $wakeMagic = if ($pm.WakeOnMagicPacket) { $pm.WakeOnMagicPacket.ToString() } else { 'n/d' }

    $pmList += [ordered]@{
        name                         = $a.Name
        allowComputerToTurnOffDevice = $turnOff
        deviceSleepOnDisconnect      = $sleepDisc
        selectiveSuspend             = $selSusp
        wakeOnMagicPacket            = $wakeMagic
    }

    $note = $null
    if ($turnOff -eq 'Enabled') { $note = '"o computador pode desligar este dispositivo" está LIGADO' }
    Write-Row $a.Name ("TurnOff={0} SleepOnDisconnect={1} SelSuspend={2} WoL={3}" -f $turnOff, $sleepDisc, $selSusp, $wakeMagic) $note
}
$script:Report.adapterPowerManagement = $pmList

# ---------------------------------------------------------------------------
# QoS / largura de banda reservada
# ---------------------------------------------------------------------------
Write-Section 'QoS (Psched)'
$qosPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Psched'
$qos = Read-RegValue $qosPath 'NonBestEffortLimit'
$script:Report.qosNonBestEffortLimit = $qos
Write-Row 'NonBestEffortLimit' $(if ($null -eq $qos) { '(não definido)' } else { "$qos%" }) 'padrão efetivo 20%; willLag usa 0'

# ---------------------------------------------------------------------------
# Saída
# ---------------------------------------------------------------------------
$script:Report.generatedAt = (Get-Date).ToString('o')

if ($Json) {
    $script:Report | ConvertTo-Json -Depth 8
} else {
    Write-Host ''
    Write-Host 'Nada foi alterado por este script.' -ForegroundColor Green
    Write-Host '  Aplicar : Set-WillLagLowLatency.ps1      (exige administrador)' -ForegroundColor Green
    Write-Host '  Reverter: Restore-WillLagNetwork.ps1     (exige administrador)' -ForegroundColor Green
    Write-Host '  Backup  : Backup-WillLagNetwork.ps1      (só leitura + arquivos)' -ForegroundColor Green
    Write-Host ''
}
