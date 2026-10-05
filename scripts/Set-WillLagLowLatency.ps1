<#
.SYNOPSIS
    Aplica as otimizações locais de baixa latência do willLag, sem o app.

.DESCRIPTION
    Faz o MESMO conjunto de alterações que o "Modo Ultra Low-Latency" do willLag,
    com backup automático antes de tocar em qualquer coisa:

      1. Nagle            TcpAckFrequency=1, TCPNoDelay=1, TcpDelAckTicks=0
                          em TODAS as interfaces com IP (as que o jogo usa).
      2. MMCSS            NetworkThrottlingIndex=0xffffffff, SystemResponsiveness=0
                          e tarefa "Games" (GPU Priority=8, Priority=6,
                          Scheduling Category=High, SFIO Priority=High).
      3. TCP global       autotuninglevel=normal, ecncapability=disabled, rss=enabled.
                          (-Legacy adiciona timestamps/chimney, só faz sentido em
                          Windows 7/8; em build >= 9200 o script avisa e ignora.)
      4. Congestionamento  ctcp SOMENTE se o sistema listar o provedor como
                          suportado (nunca às cegas).
      5. QoS              NonBestEffortLimit=0 (libera a banda reservada).
      6. Wi-Fi (-IncludeWifi)
                          netsh wlan set autoconfig enabled=no (pausa a varredura
                          que causa lag spike a cada 30-60s), USB Selective
                          Suspend desativado e "o computador pode desligar este
                          dispositivo" desmarcado no adaptador.
      7. DNS (-DnsProvider)  aplica o resolvedor e limpa o cache.
      8. MTU (-Mtu)          define o MTU da interface ativa (só se informado).

    Itens de SESSÃO (autoconfig) são gravados em session-restore.txt com o
    comando exato para reativar — no app isso é automático ao pausar/fechar.

    EXIGE ADMINISTRADOR. Nada é alterado com -DryRun.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-WillLagLowLatency.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-WillLagLowLatency.ps1 -IncludeWifi -DnsProvider cloudflare

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-WillLagLowLatency.ps1 -IncludeWifi -Mtu 1492 -CongestionProvider ctcp
#>

[CmdletBinding()]
param(
    [ValidateSet('none', 'cloudflare', 'cloudflare-malware', 'google', 'quad9', 'opendns', 'adguard', 'dhcp')]
    [string]$DnsProvider = 'none',

    [ValidateSet('auto', 'ctcp', 'cubic', 'none')]
    [string]$CongestionProvider = 'auto',

    [ValidateRange(0, 100)]
    [int]$SystemResponsiveness = 0,

    [ValidateRange(576, 9000)]
    [int]$Mtu = 0,

    [switch]$IncludeWifi,
    [switch]$SkipQos,
    [switch]$Legacy,
    [switch]$DryRun,
    [switch]$NoBackup,
    [string]$BackupFolder
)

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------
$MM_PATH = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
$GAMES_PATH = "$MM_PATH\Tasks\Games"
$IFACE_ROOT = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
$QOS_PATH = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Psched'
$USB_SUBGROUP = '2a737441-1930-4402-8d77-b2bebba308a3'
$USB_SETTING = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'

$DNS_MAP = @{
    'cloudflare'         = @('1.1.1.1', '1.0.0.1')
    'cloudflare-malware' = @('1.1.1.2', '1.0.0.2')
    'google'             = @('8.8.8.8', '8.8.4.4')
    'quad9'              = @('9.9.9.9', '149.112.112.112')
    'opendns'            = @('208.67.222.222', '208.67.220.220')
    'adguard'            = @('94.140.14.14', '94.140.15.15')
}

$script:Applied = @()
$script:Skipped = @()
$script:Failed = @()
$script:SessionRestore = @()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step([string]$message) { Write-Host "  -> $message" -ForegroundColor Gray }
function Write-Ok([string]$message) { Write-Host "  [ok] $message" -ForegroundColor Green }
function Write-Warn2([string]$message) { Write-Host "  [!] $message" -ForegroundColor Yellow }
function Write-Bad([string]$message) { Write-Host "  [x] $message" -ForegroundColor Red }

function Write-Section([string]$title) {
    Write-Host ''
    Write-Host ('-' * 70) -ForegroundColor DarkCyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ('-' * 70) -ForegroundColor DarkCyan
}

function Add-Applied([string]$what, [string]$detail, [string]$undo) {
    $script:Applied += [pscustomobject]@{ what = $what; detail = $detail; undo = $undo }
}
function Add-Skipped([string]$what, [string]$reason) {
    $script:Skipped += [pscustomobject]@{ what = $what; reason = $reason }
}
function Add-Failed([string]$what, [string]$reason) {
    $script:Failed += [pscustomobject]@{ what = $what; reason = $reason }
}

function Set-RegDWord([string]$path, [string]$name, [int]$value, [string]$label) {
    if ($DryRun) { Write-Step "[dry-run] $label = $value"; return $true }
    try {
        if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
        New-ItemProperty -Path $path -Name $name -Value $value -PropertyType DWord -Force | Out-Null
        Write-Ok "$label = $value"
        return $true
    } catch {
        Write-Bad "$label falhou: $($_.Exception.Message)"
        return $false
    }
}

function Set-RegString([string]$path, [string]$name, [string]$value, [string]$label) {
    if ($DryRun) { Write-Step "[dry-run] $label = '$value'"; return $true }
    try {
        if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
        New-ItemProperty -Path $path -Name $name -Value $value -PropertyType String -Force | Out-Null
        Write-Ok "$label = '$value'"
        return $true
    } catch {
        Write-Bad "$label falhou: $($_.Exception.Message)"
        return $false
    }
}

function Run-NetshLine([string]$command, [string]$label) {
    if ($DryRun) { Write-Step "[dry-run] netsh $command"; return $true }

    # Argumentos sem espaços embutidos: separar por espaço é seguro e evita o
    # quoting do cmd.exe (que come aspas de nomes de interface).
    $parts = @($command -split ' ')
    # Passar o array direto faz o PowerShell expandir cada elemento como um
    # argumento nativo (splatting @parts nem sempre funciona com .exe no 5.1).
    $out = (& netsh.exe $parts 2>&1 | Out-String).Trim()
    $code = $LASTEXITCODE

    if ($code -ne 0 -or $out -match 'incorreto|incorrect|denied|negado|failed|falha|não foi|not recognized|invalid') {
        Write-Bad "$label -> $out"
        return $false
    }
    Write-Ok "$label ($command)"
    return $true
}

# ---------------------------------------------------------------------------
# Pré-condições
# ---------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ''
Write-Host '  willLag - otimização local de baixa latência (script standalone)' -ForegroundColor Cyan
Write-Host ''

if (-not $isAdmin) {
    Write-Host '  [ERRO] Este script precisa de privilégios de Administrador.' -ForegroundColor Red
    Write-Host '         Clique com o botão direito no PowerShell -> "Executar como administrador",' -ForegroundColor Red
    Write-Host '         ou use o willLag (ele pede elevação por ação, via UAC).' -ForegroundColor Red
    Write-Host '         NADA foi alterado.' -ForegroundColor Red
    exit 2
}

$build = [int][Environment]::OSVersion.Version.Build
$isModern = $build -ge 9200
Write-Host ("  Windows build {0} ({1})" -f $build, $(if ($isModern) { 'moderno' } else { 'legado' })) -ForegroundColor Gray
Write-Host ("  Modo: {0}" -f $(if ($DryRun) { 'DRY-RUN (nada será alterado)' } else { 'APLICAÇÃO REAL' })) -ForegroundColor Gray

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
$stateJson = $null
if (-not $DryRun -and -not $NoBackup) {
    Write-Section 'Backup do estado anterior'
    $backupScript = Join-Path $PSScriptRoot 'Backup-WillLagNetwork.ps1'
    if (-not $BackupFolder) {
        $BackupFolder = Join-Path $env:APPDATA ("willLag\standalone-backups\{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    if (Test-Path $backupScript) {
        & $backupScript -Folder $BackupFolder
        $stateJson = Join-Path $BackupFolder 'state.json'
        if (Test-Path $stateJson) { Add-Applied 'backup' $stateJson "(já gravado em $stateJson)" }
    } else {
        Write-Warn2 "Backup-WillLagNetwork.ps1 não encontrado ao lado deste script; seguindo sem backup JSON."
    }
} elseif ($NoBackup) {
    Write-Warn2 'Backup desativado (-NoBackup). A restauração exata dependerá de um backup anterior.'
}

# ---------------------------------------------------------------------------
# Interface preferida (a que o jogo usa)
# ---------------------------------------------------------------------------
Write-Section 'Interface ativa'
$preferred = $null
$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
            Sort-Object { [int]$_.RouteMetric + [int]$_.ifMetric })
if ($routes.Count -gt 0) { $preferred = $routes[0] }

$preferredCfg = $null
if ($preferred) {
    foreach ($c in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) {
        if ($c.InterfaceIndex -eq $preferred.ifIndex) { $preferredCfg = $c; break }
    }
}
if ($preferred) {
    Write-Ok ("ifIndex {0} ({1}) via {2}" -f $preferred.ifIndex, $preferredCfg.InterfaceAlias, $preferred.NextHop)
} else {
    Write-Warn2 'Nenhuma rota padrão 0.0.0.0/0 encontrada — DNS/MTU serão pulados.'
}

# ---------------------------------------------------------------------------
# 1) Nagle
# ---------------------------------------------------------------------------
Write-Section '1) Nagle (TcpAckFrequency / TCPNoDelay)'
$nagleCount = 0
foreach ($k in @(Get-ChildItem $IFACE_ROOT -ErrorAction SilentlyContinue)) {
    $dhcpIp = (Get-ItemProperty -Path $k.PSPath -Name DhcpIPAddress -ErrorAction SilentlyContinue).DhcpIPAddress
    $staticIp = (Get-ItemProperty -Path $k.PSPath -Name IPAddress -ErrorAction SilentlyContinue).IPAddress

    $hasIp = $false
    if ($dhcpIp -and "$dhcpIp" -ne '0.0.0.0') { $hasIp = $true }
    if ($staticIp) { foreach ($s in @($staticIp)) { if ("$s" -ne '0.0.0.0' -and "$s" -ne '') { $hasIp = $true } } }
    if (-not $hasIp) { continue }

    $nagleCount++
    $ok1 = Set-RegDWord $k.PSPath 'TcpAckFrequency' 1 "TcpAckFrequency [$($k.PSChildName)]"
    $ok2 = Set-RegDWord $k.PSPath 'TCPNoDelay' 1 "TCPNoDelay [$($k.PSChildName)]"
    $ok3 = Set-RegDWord $k.PSPath 'TcpDelAckTicks' 0 "TcpDelAckTicks [$($k.PSChildName)]"
    if ($ok1 -and $ok2 -and $ok3) {
        Add-Applied 'nagle' "interface $($k.PSChildName)" 'remover TcpAckFrequency/TCPNoDelay/TcpDelAckTicks (ou Restore-WillLagNetwork.ps1)'
    }
}
if ($nagleCount -eq 0) { Write-Warn2 'Nenhuma interface com IP: Nagle não foi alterado.' }
Write-Step "interfaces alteradas: $nagleCount (novas conexões já nascem sem atraso de ACK)"

# ---------------------------------------------------------------------------
# 2) MMCSS / SystemProfile
# ---------------------------------------------------------------------------
Write-Section '2) Multimedia SystemProfile (throttling, responsividade, Games)'
# 0xffffffff como DWORD: o Int32 -1 tem EXATAMENTE esses 32 bits, e o provider
# de registro grava o padrão de bits (não o sinal). Tentar passar 4294967295
# estoura a conversão para Int32 — por isso o -1 explícito, conferido depois.
if (Set-RegDWord $MM_PATH 'NetworkThrottlingIndex' -1 'NetworkThrottlingIndex') {
    if (-not $DryRun) {
        $readBack = (Get-ItemProperty -Path $MM_PATH -Name NetworkThrottlingIndex -ErrorAction SilentlyContinue).NetworkThrottlingIndex
        $readHex = '0x{0:x8}' -f $readBack
        if ($readHex -eq '0xffffffff') { Write-Ok "confirmado: NetworkThrottlingIndex = $readHex" }
        else { Write-Warn2 "valor gravado não bateu com 0xffffffff (lido: $readHex)" }
    }
    Add-Applied 'networkThrottling' 'NetworkThrottlingIndex=0xffffffff' 'NetworkThrottlingIndex=10'
}
if (Set-RegDWord $MM_PATH 'SystemResponsiveness' $SystemResponsiveness 'SystemResponsiveness') {
    Add-Applied 'systemResponsiveness' "SystemResponsiveness=$SystemResponsiveness" 'SystemResponsiveness=20'
}

if (-not (Test-Path $GAMES_PATH)) {
    if (-not $DryRun) { New-Item -Path $GAMES_PATH -Force | Out-Null }
    Write-Step 'chave Tasks\Games criada (não existia)'
}
if (Set-RegDWord $GAMES_PATH 'GPU Priority' 8 'Games/GPU Priority') { Add-Applied 'mmcssGames' 'GPU Priority=8' 'GPU Priority=1' }
if (Set-RegDWord $GAMES_PATH 'Priority' 6 'Games/Priority') { Add-Applied 'mmcssGames' 'Priority=6' 'Priority=1' }
if (Set-RegString $GAMES_PATH 'Scheduling Category' 'High' 'Games/Scheduling Category') { Add-Applied 'mmcssGames' "Scheduling Category='High'" "Scheduling Category='Medium'" }
if (Set-RegString $GAMES_PATH 'SFIO Priority' 'High' 'Games/SFIO Priority') { Add-Applied 'mmcssGames' "SFIO Priority='High'" "SFIO Priority='Normal'" }

# ---------------------------------------------------------------------------
# 3) TCP global via netsh
# ---------------------------------------------------------------------------
Write-Section '3) TCP global (netsh int tcp set global)'
if (Run-NetshLine 'int tcp set global autotuninglevel=normal' 'autotuninglevel=normal') {
    Add-Applied 'autoTuning' 'autotuninglevel=normal' 'netsh int tcp set global autotuninglevel=normal'
}
if (Run-NetshLine 'int tcp set global ecncapability=disabled' 'ecncapability=disabled') {
    Add-Applied 'ecn' 'ecncapability=disabled' 'netsh int tcp set global ecncapability=disabled'
}
if (Run-NetshLine 'int tcp set global rss=enabled' 'rss=enabled') {
    Add-Applied 'rss' 'rss=enabled' 'netsh int tcp set global rss=enabled'
}

if ($Legacy) {
    if ($isModern) {
        Write-Warn2 "-Legacy ignorado: chimney offload e RFC1323 timestamps foram removidos no build $build (>= 9200)."
        Add-Skipped 'legacy (chimney/timestamps)' "removidos do Windows a partir do build 9200 (atual: $build)"
    } else {
        if (Run-NetshLine 'int tcp set global chimney=disabled' 'chimney=disabled') { Add-Applied 'chimneyOffload' 'chimney=disabled' 'netsh int tcp set global chimney=enabled' }
        if (Run-NetshLine 'int tcp set global timestamps=disabled' 'timestamps=disabled') { Add-Applied 'timestamps' 'timestamps=disabled' 'netsh int tcp set global timestamps=enabled' }
    }
} else {
    Add-Skipped 'legacy (chimney/timestamps)' 'não faz parte do perfil moderno; use -Legacy em Windows 7/8'
}

# ---------------------------------------------------------------------------
# 4) Provedor de congestionamento (SOMENTE se suportado)
# ---------------------------------------------------------------------------
Write-Section '4) Provedor de controle de congestionamento'
$supRaw = (netsh int tcp show supplemental 2>&1 | Out-String)
$supported = @()
foreach ($p in @('ctcp', 'cubic', 'compound', 'newreno', 'bbr')) {
    if ($supRaw -match "\b$p\b") { $supported += $p }
}
Write-Step ("suportados neste sistema: {0}" -f $(if ($supported.Count) { $supported -join ', ' } else { 'nenhum detectado' }))

$wanted = $null
if ($CongestionProvider -eq 'auto') {
    if ($supported -contains 'ctcp') { $wanted = 'ctcp' } else { $wanted = $null }
} elseif ($CongestionProvider -ne 'none') {
    $wanted = $CongestionProvider
}

if ($wanted) {
    if ($supported -contains $wanted) {
        if (Run-NetshLine "int tcp set supplemental Internet congestionprovider=$wanted" "congestionprovider=$wanted (template Internet)") {
            Add-Applied 'congestionProvider' "Internet congestionprovider=$wanted" 'netsh int tcp set supplemental Internet congestionprovider=cubic'
        }
    } else {
        Write-Warn2 "'$wanted' NÃO é suportado por este Windows — nada foi alterado (BBR não existe na pilha nativa)."
        Add-Skipped "congestionProvider=$wanted" 'não listado em netsh int tcp show supplemental'
    }
} else {
    Write-Step 'mantendo o provedor atual (auto não encontrou ctcp).'
    Add-Skipped 'congestionProvider' 'ctcp não é suportado neste sistema; cubic (padrão) é estável'
}

# ---------------------------------------------------------------------------
# 5) QoS / banda reservada
# ---------------------------------------------------------------------------
Write-Section '5) QoS (Psched NonBestEffortLimit)'
if ($SkipQos) {
    Add-Skipped 'qosReservedBandwidth' '-SkipQos informado'
} else {
    if (-not (Test-Path $QOS_PATH)) {
        if (-not $DryRun) { New-Item -Path $QOS_PATH -Force | Out-Null }
        Write-Step 'chave Psched criada (não existia)'
    }
    if (Set-RegDWord $QOS_PATH 'NonBestEffortLimit' 0 'NonBestEffortLimit') {
        Add-Applied 'qosReservedBandwidth' 'NonBestEffortLimit=0' 'remover NonBestEffortLimit (volta ao padrão 20%)'
    }
}

# ---------------------------------------------------------------------------
# 6) Wi-Fi: varredura, USB selective suspend e energia do adaptador
# ---------------------------------------------------------------------------
Write-Section '6) Wi-Fi e energia'
if (-not $IncludeWifi) {
    Add-Skipped 'wi-fi (autoconfig/energia)' 'use -IncludeWifi para tratar lag spikes de adaptador Wi-Fi USB'
} else {
    $wifiAdapters = @()
    foreach ($a in @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)) {
        $isWifi = ($a.PhysicalMediaType -match '802\.11|Wireless') -or ($a.MediaType -match '802\.11|Wireless') -or ($a.Name -match 'Wi-?Fi|Wireless|WLAN')
        if ($isWifi) { $wifiAdapters += $a }
    }

    if ($wifiAdapters.Count -eq 0) {
        Write-Warn2 'Nenhum adaptador Wi-Fi encontrado.'
        Add-Skipped 'wlanAutoconfig' 'sem adaptador Wi-Fi'
    }

    foreach ($w in $wifiAdapters) {
        $name = $w.Name
        Write-Step "adaptador Wi-Fi: $name ($($w.InterfaceDescription))"

        if ($DryRun) {
            Write-Step "[dry-run] netsh wlan set autoconfig enabled=no interface=`"$name`""
        } else {
            # & netsh.exe com o nome como argumento único: o PowerShell cuida
            # das aspas quando o nome tem espaço ("Conexão de Rede Sem Fio").
            $out = (& netsh.exe wlan set autoconfig enabled=no interface=$name 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $out -match 'incorreto|incorrect|denied|negado|failed|falha|não foi|invalid') {
                Write-Bad "autoconfig off falhou em '$name': $out"
                Add-Failed "wlanAutoconfig [$name]" $out
            } else {
                Write-Ok "varredura pausada em '$name'"
                Add-Applied "wlanAutoconfig [$name]" 'autoconfig enabled=no (SESSÃO)' "netsh wlan set autoconfig enabled=yes interface=`"$name`""
                $script:SessionRestore += "netsh wlan set autoconfig enabled=yes interface=`"$name`""

                # Guarda de conectividade: se a rede caiu, reativa imediatamente.
                Start-Sleep -Milliseconds 700
                $stillConnected = $false
                $cfgNow = Get-NetIPConfiguration -InterfaceIndex $w.ifIndex -ErrorAction SilentlyContinue
                if ($cfgNow -and $cfgNow.IPv4DefaultGateway) {
                    $gw = $cfgNow.IPv4DefaultGateway.NextHop
                    if ($gw -and (Test-Connection -ComputerName $gw -Count 1 -Quiet -ErrorAction SilentlyContinue)) { $stillConnected = $true }
                }
                if (-not $stillConnected) {
                    Write-Warn2 "conectividade não confirmada em '$name' — reativando a varredura."
                    & netsh.exe wlan set autoconfig enabled=yes interface=$name 2>&1 | Out-Null
                    Add-Failed "wlanAutoconfig [$name]" 'revertido: gateway não respondeu após pausar a varredura'
                } else {
                    Write-Ok "conectividade confirmada (gateway respondendo) em '$name'"
                }
            }
        }

        # "O computador pode desligar este dispositivo para economizar energia"
        if ($DryRun) {
            Write-Step "[dry-run] Disable-NetAdapterPowerManagement -Name '$name'"
        } else {
            try {
                Disable-NetAdapterPowerManagement -Name $name -IncludeHidden -Confirm:$false -ErrorAction Stop
                Write-Ok "energia do adaptador desativada em '$name'"
                Add-Applied "adapterPowerManagement [$name]" 'AllowComputerToTurnOffDevice=Disabled' "Enable-NetAdapterPowerManagement -Name '$name' -Confirm:`$false"
            } catch {
                Write-Warn2 "não foi possível alterar a energia de '$name': $($_.Exception.Message)"
                Add-Skipped "adapterPowerManagement [$name]" $_.Exception.Message
            }
        }
    }

    # USB Selective Suspend (afeta dongles Wi-Fi USB)
    if ($DryRun) {
        Write-Step '[dry-run] powercfg USB selective suspend = 0 (AC e DC)'
    } else {
        & powercfg.exe /setacvalueindex SCHEME_CURRENT $USB_SUBGROUP $USB_SETTING 0 2>&1 | Out-Null
        & powercfg.exe /setdcvalueindex SCHEME_CURRENT $USB_SUBGROUP $USB_SETTING 0 2>&1 | Out-Null
        & powercfg.exe /setactive SCHEME_CURRENT 2>&1 | Out-Null
        Write-Ok 'USB Selective Suspend desativado (AC e DC)'
        Add-Applied 'usbSelectiveSuspend' 'AC=0 / DC=0' 'powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 1 (idem /setdcvalueindex)'
    }
}

# ---------------------------------------------------------------------------
# 7) DNS
# ---------------------------------------------------------------------------
Write-Section '7) DNS'
if ($DnsProvider -eq 'none') {
    Add-Skipped 'dns' 'use -DnsProvider cloudflare|google|quad9|opendns|adguard|dhcp'
} elseif (-not $preferredCfg) {
    Add-Skipped 'dns' 'nenhuma interface ativa identificada'
} elseif ($DryRun) {
    Write-Step "[dry-run] DNS em ifIndex $($preferred.ifIndex) -> $DnsProvider"
} else {
    if ($DnsProvider -eq 'dhcp') {
        try {
            Set-DnsClientServerAddress -InterfaceIndex $preferred.ifIndex -ResetServerAddresses -ErrorAction Stop
            Write-Ok "DNS devolvido para automático (DHCP) em '$($preferredCfg.InterfaceAlias)'"
            Add-Applied 'dns' 'DHCP (automático)' '(já está automático)'
        } catch {
            Write-Bad "falha ao voltar para DHCP: $($_.Exception.Message)"
            Add-Failed 'dns' $_.Exception.Message
        }
    } else {
        $servers = $DNS_MAP[$DnsProvider]
        try {
            Set-DnsClientServerAddress -InterfaceIndex $preferred.ifIndex -ServerAddresses $servers -ErrorAction Stop
            Write-Ok ("DNS definido como {0} em '{1}'" -f ($servers -join ' / '), $preferredCfg.InterfaceAlias)
            Add-Applied 'dns' ($servers -join ' / ') 'Set-DnsClientServerAddress -InterfaceIndex <ifIndex> -ResetServerAddresses'
        } catch {
            Write-Bad "falha ao definir DNS: $($_.Exception.Message)"
            Add-Failed 'dns' $_.Exception.Message
        }
    }

    Clear-DnsClientCache -ErrorAction SilentlyContinue
    & ipconfig.exe /flushdns 2>&1 | Out-Null
    Write-Ok 'cache DNS limpo'
}

# ---------------------------------------------------------------------------
# 8) MTU
# ---------------------------------------------------------------------------
Write-Section '8) MTU'
if ($Mtu -eq 0) {
    Add-Skipped 'mtu' 'use -Mtu <576..9000> (ex.: 1492 para PPPoE). Descubra o ideal no app ou com ping -f -l.'
} elseif (-not $preferredCfg) {
    Add-Skipped 'mtu' 'nenhuma interface ativa identificada'
} elseif ($DryRun) {
    Write-Step "[dry-run] netsh interface ipv4 set subinterface $($preferred.ifIndex) mtu=$Mtu store=persistent"
} else {
    $before = (Get-NetIPInterface -InterfaceIndex $preferred.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).NlMtu
    $out = (& netsh.exe interface ipv4 set subinterface $preferred.ifIndex "mtu=$Mtu" store=persistent 2>&1 | Out-String).Trim()
    $after = (Get-NetIPInterface -InterfaceIndex $preferred.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).NlMtu
    if ($after -eq $Mtu) {
        Write-Ok "MTU definido como $Mtu (antes: $before)"
        Add-Applied 'mtu' "ifIndex $($preferred.ifIndex): $before -> $Mtu" "netsh interface ipv4 set subinterface $($preferred.ifIndex) mtu=$before store=persistent"
    } else {
        Write-Bad "MTU não confirmado (netsh disse: $out)"
        Add-Failed 'mtu' $out
    }
}

# ---------------------------------------------------------------------------
# Resumo + comandos de sessão
# ---------------------------------------------------------------------------
Write-Section 'Resumo'
Write-Host ("  aplicados : {0}" -f $script:Applied.Count) -ForegroundColor Green
Write-Host ("  pulados   : {0}" -f $script:Skipped.Count) -ForegroundColor Yellow
Write-Host ("  falhas    : {0}" -f $script:Failed.Count) -ForegroundColor Red

if ($script:Failed.Count) {
    Write-Host ''
    Write-Host '  Falhas:' -ForegroundColor Red
    foreach ($f in $script:Failed) { Write-Host ("    - {0}: {1}" -f $f.what, $f.reason) -ForegroundColor Red }
}
if ($script:Skipped.Count) {
    Write-Host ''
    Write-Host '  Pulados (com o motivo):' -ForegroundColor Yellow
    foreach ($s in $script:Skipped) { Write-Host ("    - {0}: {1}" -f $s.what, $s.reason) -ForegroundColor DarkYellow }
}

if (-not $DryRun) {
    $targetDir = if ($BackupFolder) { $BackupFolder } else { Join-Path $env:APPDATA 'willLag\standalone-backups' }
    try {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        $appliedFile = Join-Path $targetDir 'last-apply.json'
        [pscustomobject]@{
            appliedAt = (Get-Date).ToString('o')
            backup    = $stateJson
            applied   = $script:Applied
            skipped   = $script:Skipped
            failed    = $script:Failed
        } | ConvertTo-Json -Depth 6 | Set-Content -Path $appliedFile -Encoding UTF8

        if ($script:SessionRestore.Count) {
            $sessionFile = Join-Path $targetDir 'session-restore.txt'
            @(
                '# Ajustes de SESSAO aplicados pelo Set-WillLagLowLatency.ps1',
                '# Rode estes comandos ao terminar de jogar (o app faz isso sozinho):',
                ''
            ) + $script:SessionRestore | Set-Content -Path $sessionFile -Encoding UTF8
            Write-Host ''
            Write-Host '  IMPORTANTE: a varredura Wi-Fi ficou pausada (ajuste de sessão).' -ForegroundColor Yellow
            Write-Host "  Comandos gravados em: $sessionFile" -ForegroundColor Yellow
            foreach ($line in $script:SessionRestore) { Write-Host "    $line" -ForegroundColor Yellow }
        }

        Write-Host ''
        Write-Host "  Registro do que foi feito: $appliedFile" -ForegroundColor Gray
    } catch {
        Write-Warn2 "não foi possível gravar o resumo: $($_.Exception.Message)"
    }
}

Write-Host ''
Write-Host '  Para desfazer TUDO:' -ForegroundColor Cyan
if ($stateJson) {
    Write-Host "    powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -BackupFile '$stateJson'" -ForegroundColor Cyan
} else {
    Write-Host '    powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -Defaults' -ForegroundColor Cyan
}
Write-Host ''

if ($script:Failed.Count -and -not $script:Applied.Count) { exit 1 }
exit 0
