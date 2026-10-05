<#
.SYNOPSIS
    Desfaz as otimizações do willLag com precisão (a partir do backup) ou
    devolve o Windows aos valores padrão documentados.

.DESCRIPTION
    Dois modos:

      -BackupFile <state.json>  (PADRÃO: o backup mais recente em
                                 %APPDATA%\willLag\standalone-backups)
          Restaura EXATAMENTE o que havia antes — inclusive "o valor não
          existia" (aí a entrada é removida, não zerada). É o modo correto.

      -Defaults
          Sem backup: grava os valores padrão documentados do Windows
          (NetworkThrottlingIndex=10, SystemResponsiveness=20, Games=1/1/
          Medium/Normal, autotuninglevel=normal, ecn=disabled, rss=enabled,
          NonBestEffortLimit removido, DNS de volta para DHCP, energia do
          adaptador reativada, varredura Wi-Fi religada).

    Itens que o script NÃO consegue determinar com segurança são PULADOS e
    listados no resumo — reverter para um valor errado é pior do que não
    reverter.

    EXIGE ADMINISTRADOR. Nada é alterado com -DryRun.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -Defaults

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -BackupFile "$env:APPDATA\willLag\standalone-backups\20260101-120000\state.json" -DryRun
#>

[CmdletBinding()]
param(
    [string]$BackupFile,
    [switch]$Defaults,
    [switch]$SkipWifi,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$MM_PATH = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
$GAMES_PATH = "$MM_PATH\Tasks\Games"
$QOS_PATH = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Psched'
$USB_SUBGROUP = '2a737441-1930-4402-8d77-b2bebba308a3'
$USB_SETTING = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'

$script:Restored = @()
$script:Skipped = @()
$script:Failed = @()

function Write-Section([string]$title) {
    Write-Host ''
    Write-Host ('-' * 70) -ForegroundColor DarkCyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ('-' * 70) -ForegroundColor DarkCyan
}
function Write-Step([string]$m) { Write-Host "  -> $m" -ForegroundColor Gray }
function Write-Ok([string]$m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Bad([string]$m) { Write-Host "  [x] $m" -ForegroundColor Red }

function Add-Restored([string]$what, [string]$detail) { $script:Restored += [pscustomobject]@{ what = $what; detail = $detail } }
function Add-Skipped([string]$what, [string]$reason) { $script:Skipped += [pscustomobject]@{ what = $what; reason = $reason } }
function Add-Failed([string]$what, [string]$reason) { $script:Failed += [pscustomobject]@{ what = $what; reason = $reason } }

# Restaura um valor de registro a partir do par {existed, value} capturado.
function Restore-RegValue([string]$path, [string]$name, $captured, [string]$label, $fallback) {
    if ($null -eq $captured -and $null -eq $fallback) {
        Add-Skipped $label 'sem valor capturado e sem padrão conhecido'
        return
    }

    $existed = $true
    $value = $null
    if ($null -ne $captured) {
        $existed = [bool]$captured.existed
        $value = $captured.value
    } else {
        $existed = $true
        $value = $fallback
    }

    if (-not $existed) {
        if ($DryRun) { Write-Step "[dry-run] remover $label"; return }
        try {
            if (Test-Path $path) {
                $item = Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
                if ($null -ne $item) { Remove-ItemProperty -Path $path -Name $name -Force -ErrorAction Stop }
            }
            Write-Ok "$label removido (não existia antes)"
            Add-Restored $label 'valor removido (não existia)'
        } catch {
            Write-Bad "$label : $($_.Exception.Message)"
            Add-Failed $label $_.Exception.Message
        }
        return
    }

    if ($DryRun) { Write-Step "[dry-run] $label = $value"; return }
    try {
        if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
        $type = 'DWord'
        if ($value -is [string]) { $type = 'String' }
        New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
        Write-Ok "$label = $value"
        Add-Restored $label "$value"
    } catch {
        Write-Bad "$label : $($_.Exception.Message)"
        Add-Failed $label $_.Exception.Message
    }
}

function Run-NetshLine([string]$command, [string]$label) {
    if ($DryRun) { Write-Step "[dry-run] netsh $command"; return $true }
    $parts = @($command -split ' ')
    $out = (& netsh.exe $parts 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $out -match 'incorreto|incorrect|denied|negado|failed|falha|não foi|invalid') {
        Write-Bad "$label -> $out"
        Add-Failed $label $out
        return $false
    }
    Write-Ok "$label"
    Add-Restored $label $command
    return $true
}

# Lê um campo do dump textual de `netsh int tcp show global` (pt-BR e en-US).
function Get-TcpGlobalValue([string]$raw, [string]$enLabel, [string]$ptPattern) {
    foreach ($line in ($raw -split "`r?`n")) {
        $idx = $line.IndexOf(':')
        if ($idx -lt 0) { continue }
        $label = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if (-not $label -or -not $value) { continue }

        $hit = $false
        if ($enLabel -and $label -match $enLabel) { $hit = $true }
        if (-not $hit -and $ptPattern -and $label -match $ptPattern) { $hit = $true }
        if (-not $hit) { continue }

        # Valores localizados -> normaliza para o vocabulário do netsh.
        $v = $value.ToLower()
        if ($v -match 'habilitad|ativad|enabled|^\(on\)|sim') { return 'enabled' }
        if ($v -match 'desabilitad|desativad|disabled|^\(off\)|não|nao') { return 'disabled' }
        if ($v -match 'normal|padr|standard') { return 'normal' }
        if ($v -match 'restrict') { return 'restricted' }
        if ($v -match 'highlyrestrict') { return 'highlyrestricted' }
        if ($v -match 'experimental') { return 'experimental' }
        if ($v -match '^(ctcp|cubic|compound|newreno|none|default)$') { return $matches[1] }
        if ($v -match '^\d+$') { return $v }
        return $null
    }
    return $null
}

# ---------------------------------------------------------------------------
# Pré-condições
# ---------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Host '  [ERRO] Este script precisa de privilégios de Administrador.' -ForegroundColor Red
    Write-Host '         Nada foi alterado.' -ForegroundColor Red
    exit 2
}

Write-Host ''
Write-Host '  willLag - restauração do estado de rede' -ForegroundColor Cyan
Write-Host ("  Modo: {0}" -f $(if ($DryRun) { 'DRY-RUN' } else { 'REAL' })) -ForegroundColor Gray

# ---------------------------------------------------------------------------
# Localiza o backup
# ---------------------------------------------------------------------------
$state = $null
$mode = 'defaults'

if (-not $Defaults) {
    if (-not $BackupFile) {
        $root = Join-Path $env:APPDATA 'willLag\standalone-backups'
        if (Test-Path $root) {
            $latest = Get-ChildItem -Path $root -Recurse -Filter 'state.json' -ErrorAction SilentlyContinue |
                      Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($latest) { $BackupFile = $latest.FullName }
        }
    }

    if ($BackupFile -and (Test-Path $BackupFile)) {
        try {
            $state = Get-Content -Path $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $mode = 'backup'
            Write-Host ("  Backup: {0}" -f $BackupFile) -ForegroundColor Gray
            Write-Host ("  Criado em: {0}" -f $state.createdAt) -ForegroundColor Gray
        } catch {
            Write-Bad "Não foi possível ler o backup: $($_.Exception.Message)"
            Write-Warn2 'Continuando no modo -Defaults (valores padrão do Windows).'
        }
    } else {
        Write-Warn2 'Nenhum backup encontrado. Usando os valores padrão do Windows.'
        Write-Warn2 'Para precisão total, rode Backup-WillLagNetwork.ps1 ANTES de otimizar.'
    }
}

# ---------------------------------------------------------------------------
# 1) Nagle
# ---------------------------------------------------------------------------
Write-Section '1) Nagle (TcpAckFrequency / TCPNoDelay / TcpDelAckTicks)'
if ($mode -eq 'backup') {
    foreach ($iface in $state.nagle) {
        $path = "Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($iface.guid)"
        if (-not (Test-Path $path)) {
            Add-Skipped "nagle [$($iface.guid)]" 'a interface não existe mais'
            continue
        }
        Restore-RegValue $path 'TcpAckFrequency' $iface.values.TcpAckFrequency "nagle.TcpAckFrequency [$($iface.guid)]" $null
        Restore-RegValue $path 'TCPNoDelay' $iface.values.TCPNoDelay "nagle.TCPNoDelay [$($iface.guid)]" $null
        Restore-RegValue $path 'TcpDelAckTicks' $iface.values.TcpDelAckTicks "nagle.TcpDelAckTicks [$($iface.guid)]" $null
    }
} else {
    # Padrão do Windows: os três valores NÃO existem na chave da interface.
    foreach ($k in @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces' -ErrorAction SilentlyContinue)) {
        foreach ($name in @('TcpAckFrequency', 'TCPNoDelay', 'TcpDelAckTicks')) {
            $item = Get-ItemProperty -Path $k.PSPath -Name $name -ErrorAction SilentlyContinue
            if ($null -eq $item) { continue }
            if ($DryRun) { Write-Step "[dry-run] remover $name de $($k.PSChildName)"; continue }
            try {
                Remove-ItemProperty -Path $k.PSPath -Name $name -Force -ErrorAction Stop
                Write-Ok "$name removido de $($k.PSChildName)"
                Add-Restored "nagle.$name [$($k.PSChildName)]" 'removido (padrão do Windows)'
            } catch {
                Add-Failed "nagle.$name [$($k.PSChildName)]" $_.Exception.Message
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 2) Multimedia SystemProfile
# ---------------------------------------------------------------------------
Write-Section '2) Multimedia SystemProfile'
if ($mode -eq 'backup') {
    Restore-RegValue $MM_PATH 'NetworkThrottlingIndex' $state.systemProfile.values.NetworkThrottlingIndex 'NetworkThrottlingIndex' 10
    Restore-RegValue $MM_PATH 'SystemResponsiveness' $state.systemProfile.values.SystemResponsiveness 'SystemResponsiveness' 20
    Restore-RegValue $GAMES_PATH 'GPU Priority' $state.systemProfile.games.values.'GPU Priority' 'Games/GPU Priority' 1
    Restore-RegValue $GAMES_PATH 'Priority' $state.systemProfile.games.values.'Priority' 'Games/Priority' 1
    Restore-RegValue $GAMES_PATH 'Scheduling Category' $state.systemProfile.games.values.'Scheduling Category' 'Games/Scheduling Category' 'Medium'
    Restore-RegValue $GAMES_PATH 'SFIO Priority' $state.systemProfile.games.values.'SFIO Priority' 'Games/SFIO Priority' 'Normal'
} else {
    Restore-RegValue $MM_PATH 'NetworkThrottlingIndex' $null 'NetworkThrottlingIndex' 10
    Restore-RegValue $MM_PATH 'SystemResponsiveness' $null 'SystemResponsiveness' 20
    Restore-RegValue $GAMES_PATH 'GPU Priority' $null 'Games/GPU Priority' 1
    Restore-RegValue $GAMES_PATH 'Priority' $null 'Games/Priority' 1
    Restore-RegValue $GAMES_PATH 'Scheduling Category' $null 'Games/Scheduling Category' 'Medium'
    Restore-RegValue $GAMES_PATH 'SFIO Priority' $null 'Games/SFIO Priority' 'Normal'
}

# ---------------------------------------------------------------------------
# 3) QoS
# ---------------------------------------------------------------------------
Write-Section '3) QoS (Psched)'
if ($mode -eq 'backup') {
    Restore-RegValue $QOS_PATH 'NonBestEffortLimit' $state.qos.values.NonBestEffortLimit 'NonBestEffortLimit' $null
} else {
    Restore-RegValue $QOS_PATH 'NonBestEffortLimit' $null 'NonBestEffortLimit' $null
}

# ---------------------------------------------------------------------------
# 4) TCP global (netsh)
# ---------------------------------------------------------------------------
Write-Section '4) TCP global (netsh)'
$targets = @(
    @{ setting = 'autotuninglevel'; en = 'auto.?tun'; pt = 'auto.?ajuste'; default = 'normal' },
    @{ setting = 'ecncapability'; en = '\becn\b capability'; pt = 'capacidade\s+ecn'; default = 'disabled' },
    @{ setting = 'rss'; en = 'receive.?side scaling'; pt = '\brss\b'; default = 'enabled' },
    @{ setting = 'rsc'; en = 'segment coalescing'; pt = 'coalesc'; default = 'enabled' },
    @{ setting = 'timestamps'; en = 'timestamp'; pt = 'carimbo'; default = 'disabled' },
    @{ setting = 'chimney'; en = 'chimney'; pt = 'chimney'; default = 'disabled' },
    @{ setting = 'initialrto'; en = 'initial\s*rto'; pt = 'rto inicial'; default = '3000' },
    @{ setting = 'fastopen'; en = 'fast\s*open'; pt = 'abertura\s*r'; default = 'enabled' }
)

if ($mode -eq 'backup' -and $state.netsh -and $state.netsh.globalRaw) {
    $raw = $state.netsh.globalRaw
    foreach ($t in $targets) {
        $value = Get-TcpGlobalValue -raw $raw -enLabel $t.en -ptPattern $t.pt
        if (-not $value) {
            Add-Skipped "netsh:$($t.setting)" 'valor anterior não pôde ser lido do dump (localização?) — nada alterado'
            continue
        }
        Run-NetshLine "int tcp set global $($t.setting)=$value" "$($t.setting)=$value" | Out-Null
    }
} else {
    foreach ($t in $targets) {
        Run-NetshLine "int tcp set global $($t.setting)=$($t.default)" "$($t.setting)=$($t.default) (padrão do Windows)" | Out-Null
    }
}

# Provedor de congestionamento
$wantedProvider = $null
if ($mode -eq 'backup' -and $state.congestionProvider -and $state.congestionProvider.value) {
    $wantedProvider = $state.congestionProvider.value
} else {
    $wantedProvider = 'cubic'
}
$supRaw = (netsh int tcp show supplemental 2>&1 | Out-String)
if ($supRaw -match "\b$wantedProvider\b") {
    Run-NetshLine "int tcp set supplemental Internet congestionprovider=$wantedProvider" "congestionprovider=$wantedProvider (template Internet)" | Out-Null
} else {
    Add-Skipped "congestionprovider=$wantedProvider" 'não é suportado neste sistema; mantendo o atual'
}

# ---------------------------------------------------------------------------
# 5) Wi-Fi: varredura, energia do adaptador e USB selective suspend
# ---------------------------------------------------------------------------
Write-Section '5) Wi-Fi e energia'
if ($SkipWifi) {
    Add-Skipped 'wi-fi/energia' '-SkipWifi informado'
} else {
    if ($mode -eq 'backup') {
        foreach ($ac in $state.wlanAutoconfig.interfaces) {
            $want = if ($ac.enabled) { 'yes' } else { 'no' }
            if ($DryRun) { Write-Step "[dry-run] netsh wlan set autoconfig enabled=$want interface='$($ac.interface)'"; continue }
            $out = (& netsh.exe wlan set autoconfig "enabled=$want" "interface=$($ac.interface)" 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $out -match 'incorreto|incorrect|denied|negado|failed|falha|invalid') {
                Add-Failed "wlanAutoconfig [$($ac.interface)]" $out
            } else {
                Write-Ok "autoconfig $($ac.interface) -> enabled=$want"
                Add-Restored "wlanAutoconfig [$($ac.interface)]" "enabled=$want"
            }
        }

        foreach ($ap in $state.adapterPower) {
            if ($DryRun) { Write-Step "[dry-run] Enable-NetAdapterPowerManagement '$($ap.name)'"; continue }
            try {
                Enable-NetAdapterPowerManagement -Name $ap.name -IncludeHidden -Confirm:$false -ErrorAction Stop
                Write-Ok "energia do adaptador reativada em '$($ap.name)'"
                Add-Restored "adapterPower [$($ap.name)]" 'AllowComputerToTurnOffDevice=Enabled'
            } catch {
                Add-Skipped "adapterPower [$($ap.name)]" $_.Exception.Message
            }
        }

        $acIdx = $null; $dcIdx = $null
        if ($state.usbSelectiveSuspend) { $acIdx = $state.usbSelectiveSuspend.ac; $dcIdx = $state.usbSelectiveSuspend.dc }
        if ($null -eq $acIdx) { $acIdx = 0 }
        if ($null -eq $dcIdx) { $dcIdx = 1 }
        if ($DryRun) {
            Write-Step "[dry-run] USB selective suspend AC=$acIdx DC=$dcIdx"
        } else {
            & powercfg.exe /setacvalueindex SCHEME_CURRENT $USB_SUBGROUP $USB_SETTING $acIdx 2>&1 | Out-Null
            & powercfg.exe /setdcvalueindex SCHEME_CURRENT $USB_SUBGROUP $USB_SETTING $dcIdx 2>&1 | Out-Null
            & powercfg.exe /setactive SCHEME_CURRENT 2>&1 | Out-Null
            Write-Ok "USB selective suspend restaurado (AC=$acIdx / DC=$dcIdx)"
            Add-Restored 'usbSelectiveSuspend' "AC=$acIdx / DC=$dcIdx"
        }
    } else {
        foreach ($a in @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)) {
            $isWifi = ($a.PhysicalMediaType -match '802\.11|Wireless') -or ($a.MediaType -match '802\.11|Wireless') -or ($a.Name -match 'Wi-?Fi|Wireless|WLAN')
            if ($isWifi) {
                if ($DryRun) { Write-Step "[dry-run] netsh wlan set autoconfig enabled=yes interface='$($a.Name)'"; continue }
                $out = (& netsh.exe wlan set autoconfig enabled=yes "interface=$($a.Name)" 2>&1 | Out-String).Trim()
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "varredura religada em '$($a.Name)'"
                    Add-Restored "wlanAutoconfig [$($a.Name)]" 'enabled=yes'
                } else { Add-Failed "wlanAutoconfig [$($a.Name)]" $out }
            }

            try {
                if (-not $DryRun) {
                    Enable-NetAdapterPowerManagement -Name $a.Name -IncludeHidden -Confirm:$false -ErrorAction Stop
                    Write-Ok "energia do adaptador reativada em '$($a.Name)'"
                    Add-Restored "adapterPower [$($a.Name)]" 'AllowComputerToTurnOffDevice=Enabled'
                }
            } catch {
                Add-Skipped "adapterPower [$($a.Name)]" $_.Exception.Message
            }
        }

        if ($DryRun) {
            Write-Step '[dry-run] USB selective suspend AC=0 DC=1 (padrão do plano Equilibrado)'
        } else {
            & powercfg.exe /setacvalueindex SCHEME_CURRENT $USB_SUBGROUP $USB_SETTING 0 2>&1 | Out-Null
            & powercfg.exe /setdcvalueindex SCHEME_CURRENT $USB_SUBGROUP $USB_SETTING 1 2>&1 | Out-Null
            & powercfg.exe /setactive SCHEME_CURRENT 2>&1 | Out-Null
            Write-Ok 'USB selective suspend no padrão (AC=0 / DC=1)'
            Add-Restored 'usbSelectiveSuspend' 'AC=0 / DC=1 (padrão do plano Equilibrado)'
        }
    }
}

# ---------------------------------------------------------------------------
# 6) DNS
# ---------------------------------------------------------------------------
Write-Section '6) DNS'
if ($mode -eq 'backup') {
    foreach ($d in $state.dns) {
        $servers = @($d.servers)
        try {
            if ($DryRun) { Write-Step "[dry-run] DNS ifIndex $($d.ifIndex) -> $(if ($d.wasDhcp) { 'DHCP' } else { $servers -join ', ' })"; continue }
            if ($d.wasDhcp -or $servers.Count -eq 0) {
                Set-DnsClientServerAddress -InterfaceIndex $d.ifIndex -ResetServerAddresses -ErrorAction Stop
                Write-Ok "DNS da interface $($d.ifIndex) voltou para automático (DHCP)"
                Add-Restored "dns [ifIndex $($d.ifIndex)]" 'DHCP'
            } else {
                Set-DnsClientServerAddress -InterfaceIndex $d.ifIndex -ServerAddresses $servers -ErrorAction Stop
                Write-Ok "DNS da interface $($d.ifIndex) = $($servers -join ', ')"
                Add-Restored "dns [ifIndex $($d.ifIndex)]" ($servers -join ', ')
            }
        } catch {
            Add-Failed "dns [ifIndex $($d.ifIndex)]" $_.Exception.Message
        }
    }
} else {
    foreach ($cfg in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) {
        if ($DryRun) { Write-Step "[dry-run] DNS ifIndex $($cfg.InterfaceIndex) -> DHCP"; continue }
        try {
            Set-DnsClientServerAddress -InterfaceIndex $cfg.InterfaceIndex -ResetServerAddresses -ErrorAction Stop
            Write-Ok "DNS de '$($cfg.InterfaceAlias)' voltou para automático (DHCP)"
            Add-Restored "dns [$($cfg.InterfaceAlias)]" 'DHCP'
        } catch {
            Add-Failed "dns [$($cfg.InterfaceAlias)]" $_.Exception.Message
        }
    }
}
if (-not $DryRun) {
    Clear-DnsClientCache -ErrorAction SilentlyContinue
    & ipconfig.exe /flushdns 2>&1 | Out-Null
    Write-Ok 'cache DNS limpo'
}

# ---------------------------------------------------------------------------
# 7) MTU
# ---------------------------------------------------------------------------
Write-Section '7) MTU'
if ($mode -eq 'backup') {
    foreach ($m in $state.mtu) {
        if (-not $m.mtu) { Add-Skipped "mtu [ifIndex $($m.ifIndex)]" 'MTU anterior desconhecido'; continue }
        if ($DryRun) { Write-Step "[dry-run] netsh interface ipv4 set subinterface $($m.ifIndex) mtu=$($m.mtu) store=persistent"; continue }
        $out = (& netsh.exe interface ipv4 set subinterface $m.ifIndex "mtu=$($m.mtu)" store=persistent 2>&1 | Out-String).Trim()
        $now = (Get-NetIPInterface -InterfaceIndex $m.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).NlMtu
        if ($now -eq $m.mtu) {
            Write-Ok "MTU da interface $($m.ifIndex) voltou para $($m.mtu)"
            Add-Restored "mtu [ifIndex $($m.ifIndex)]" "$($m.mtu)"
        } else {
            Add-Failed "mtu [ifIndex $($m.ifIndex)]" $out
        }
    }
} else {
    Add-Skipped 'mtu' 'sem backup não é seguro chutar o MTU; passe -BackupFile para restaurar o valor exato'
}

# ---------------------------------------------------------------------------
# Resumo
# ---------------------------------------------------------------------------
Write-Section 'Resumo da restauração'
Write-Host ("  restaurados : {0}" -f $script:Restored.Count) -ForegroundColor Green
Write-Host ("  pulados     : {0}" -f $script:Skipped.Count) -ForegroundColor Yellow
Write-Host ("  falhas      : {0}" -f $script:Failed.Count) -ForegroundColor Red

if ($script:Skipped.Count) {
    Write-Host ''
    Write-Host '  Pulados (com o motivo):' -ForegroundColor Yellow
    foreach ($s in $script:Skipped) { Write-Host ("    - {0}: {1}" -f $s.what, $s.reason) -ForegroundColor DarkYellow }
}
if ($script:Failed.Count) {
    Write-Host ''
    Write-Host '  Falhas:' -ForegroundColor Red
    foreach ($f in $script:Failed) { Write-Host ("    - {0}: {1}" -f $f.what, $f.reason) -ForegroundColor Red }
}

if (-not $DryRun) {
    $targetDir = if ($mode -eq 'backup' -and $BackupFile) { Split-Path $BackupFile -Parent } else { Join-Path $env:APPDATA 'willLag\standalone-backups' }
    try {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        $file = Join-Path $targetDir 'last-restore.json'
        [pscustomobject]@{
            restoredAt = (Get-Date).ToString('o')
            mode       = $mode
            backupFile = $BackupFile
            restored   = $script:Restored
            skipped    = $script:Skipped
            failed     = $script:Failed
        } | ConvertTo-Json -Depth 6 | Set-Content -Path $file -Encoding UTF8
        Write-Host ''
        Write-Host "  Registro da restauração: $file" -ForegroundColor Gray
    } catch {
        Write-Warn2 "não foi possível gravar o resumo: $($_.Exception.Message)"
    }
}

Write-Host ''
Write-Host '  Confirme o resultado com: Get-WillLagReport.ps1' -ForegroundColor Cyan
Write-Host '  Algumas alterações de rede só valem para novas conexões TCP;' -ForegroundColor DarkGray
Write-Host '  se quiser garantir, reinicie o PC (ou desconecte/reconecte a rede).' -ForegroundColor DarkGray
Write-Host ''

if ($script:Failed.Count -and -not $script:Restored.Count) { exit 1 }
exit 0
