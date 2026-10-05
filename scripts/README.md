# Scripts PowerShell standalone

Os quatro scripts desta pasta fazem, **fora do app**, exatamente o que o willLag
faz por dentro. Eles existem por três motivos:

1. **Plano de recuperação.** Se o app não abrir, travar ou você quiser desfazer
   tudo sem interface gráfica, há um caminho documentado e auditável.
2. **Auditoria.** `Get-WillLagReport.ps1` mostra o que está alterado na máquina
   e por quê — útil para conferir se alguma outra ferramenta ("otimizador" de
   terceiro) mexeu na pilha de rede.
3. **Automação.** Dá para aplicar antes de jogar e reverter depois via
   Agendador de Tarefas.

> Todos rodam em **Windows PowerShell 5.1** (o que já vem no Windows 10/11).
> Nenhum usa sintaxe exclusiva do PowerShell 7.
>
> Os scripts de alteração exigem **administrador** e terminam com código `2`
> (sem privilégio) ou `1` (houve falha) — nada é alterado nesses casos.

---

## 1. `Get-WillLagReport.ps1` — somente leitura

Não exige administrador e **não altera nada**.

```powershell
powershell -ExecutionPolicy Bypass -File .\Get-WillLagReport.ps1
powershell -ExecutionPolicy Bypass -File .\Get-WillLagReport.ps1 -Json   # para guardar/diffar
```

Mostra: build do Windows, adaptadores (com destaque para Wi-Fi USB), interface
preferida pela métrica de rota, `netsh int tcp show global` e `supplemental`,
provedores de congestionamento realmente suportados, valores de Nagle por
interface com IP, `NetworkThrottlingIndex`/`SystemResponsiveness`/tarefa
`Games`, estado do WLAN AutoConfig, USB Selective Suspend (AC/DC), energia dos
adaptadores, DNS, MTU e `NonBestEffortLimit`.

---

## 2. `Backup-WillLagNetwork.ps1` — ponto de restauração

```powershell
powershell -ExecutionPolicy Bypass -File .\Backup-WillLagNetwork.ps1
powershell -ExecutionPolicy Bypass -File .\Backup-WillLagNetwork.ps1 -Folder D:\backups\antes-do-jogo
```

Grava em `%APPDATA%\willLag\standalone-backups\<timestamp>\`:

| Arquivo | Para quê |
| --- | --- |
| `willlag-network-backup.reg` | Exportação nativa das chaves. Duplo clique restaura pelo `regedit`. |
| `state.json` | Estado anterior **inclusive "o valor não existia"**. É o que o script de restauração usa. |
| `netsh-dump.txt` | Saídas brutas de `netsh`/`powercfg` para conferência humana. |

O app faz o mesmo backup internamente antes de cada alteração
(`stateStore.pushBackup`) — este script é o equivalente manual.

---

## 3. `Set-WillLagLowLatency.ps1` — aplica as otimizações

```powershell
# ver o que seria feito, sem tocar em nada
powershell -ExecutionPolicy Bypass -File .\Set-WillLagLowLatency.ps1 -DryRun

# cenário típico: notebook com Wi-Fi USB, DNS Cloudflare
powershell -ExecutionPolicy Bypass -File .\Set-WillLagLowLatency.ps1 -IncludeWifi -DnsProvider cloudflare

# PPPoE (MTU 1492) + CTCP se o Windows suportar
powershell -ExecutionPolicy Bypass -File .\Set-WillLagLowLatency.ps1 -IncludeWifi -Mtu 1492 -CongestionProvider ctcp
```

Parâmetros:

| Parâmetro | Padrão | Efeito |
| --- | --- | --- |
| `-DnsProvider` | `none` | `cloudflare`, `cloudflare-malware`, `google`, `quad9`, `opendns`, `adguard`, `dhcp` ou `none` (não mexe). |
| `-CongestionProvider` | `auto` | `auto` usa **ctcp somente se o sistema listar como suportado**; `ctcp`/`cubic` explícitos são recusados se não suportados; `none` não mexe. |
| `-SystemResponsiveness` | `0` | 0 = 100% da CPU para o jogo; 20 é o padrão do Windows. |
| `-Mtu` | `0` (não mexe) | 576–9000. Descubra o valor ideal no app (busca binária com `ping -f`) antes de fixar. |
| `-IncludeWifi` | desligado | Pausa a varredura Wi-Fi (`autoconfig enabled=no`), desativa USB Selective Suspend e a economia de energia do adaptador. |
| `-SkipQos` | desligado | Não zera `NonBestEffortLimit`. |
| `-Legacy` | desligado | Adiciona `chimney=disabled` e `timestamps=disabled`. Em build ≥ 9200 o script **avisa e ignora** (esses recursos foram removidos do Windows). |
| `-DryRun` | desligado | Imprime tudo sem alterar nada. |
| `-NoBackup` | desligado | Pula o backup automático. Não recomendado. |

O que ele altera:

1. **Nagle** — `TcpAckFrequency=1`, `TCPNoDelay=1`, `TcpDelAckTicks=0` em todas
   as interfaces **com IP** (as que o jogo usa).
2. **MMCSS** — `NetworkThrottlingIndex=0xffffffff`, `SystemResponsiveness=0` e
   `Tasks\Games` (`GPU Priority=8`, `Priority=6`, `Scheduling Category=High`,
   `SFIO Priority=High`).
3. **TCP global** — `autotuninglevel=normal`, `ecncapability=disabled`,
   `rss=enabled`.
4. **Congestionamento** — só o que for suportado (nunca às cegas; BBR não existe
   na pilha nativa do Windows).
5. **QoS** — `NonBestEffortLimit=0`.
6. **Wi-Fi/energia** (com `-IncludeWifi`) — pausa a varredura, desativa USB
   Selective Suspend (AC e DC) e desmarca *"o computador pode desligar este
   dispositivo para economizar energia"*.
7. **DNS** — aplica o provedor e limpa o cache.
8. **MTU** — só com `-Mtu`.

### Ajuste de sessão: leia isto

`netsh wlan set autoconfig enabled=no` **não é persistente**: enquanto estiver
pausado, o Windows não reconecta sozinho se a rede cair. O app reverte
automaticamente ao pausar o Modo Jogo e ao fechar; o script **não fica residente**,
então:

* logo após pausar a varredura, o script testa o gateway e **reativa sozinho** se
  a conectividade não responder;
* ao final, grava os comandos exatos de desfazer em
  `%APPDATA%\willLag\standalone-backups\session-restore.txt` e os imprime.

Para religar manualmente:

```powershell
netsh wlan set autoconfig enabled=yes interface="Wi-Fi"
```

---

## 4. `Restore-WillLagNetwork.ps1` — desfaz

```powershell
# usa o backup mais recente automaticamente
powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1

# backup específico
powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -BackupFile "$env:APPDATA\willLag\standalone-backups\20260101-120000\state.json"

# sem backup: valores padrão documentados do Windows
powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -Defaults

# simular
powershell -ExecutionPolicy Bypass -File .\Restore-WillLagNetwork.ps1 -DryRun
```

Com backup, a restauração é **exata**: valor que não existia é **removido** (não
zerado), o DNS volta para DHCP quando era DHCP, o MTU volta ao número medido, o
AutoConfig volta ao estado anterior e o USB Selective Suspend volta aos índices
capturados.

Sem backup (`-Defaults`), o script grava os padrões documentados
(`NetworkThrottlingIndex=10`, `SystemResponsiveness=20`, `Games=1/1/Medium/Normal`,
`autotuninglevel=normal`, `ecncapability=disabled`, `rss=enabled`, DNS em DHCP,
energia do adaptador reativada, USB Selective Suspend AC=0/DC=1) e **pula** o que
não dá para saber com segurança — por exemplo, o MTU anterior.

Tudo que foi pulado aparece no resumo com o motivo. Restaurar um valor errado é
pior do que não restaurar.

---

## Ordem recomendada

```powershell
.\Get-WillLagReport.ps1            # 1. como está hoje
.\Backup-WillLagNetwork.ps1        # 2. ponto de restauração
.\Set-WillLagLowLatency.ps1 -DryRun -IncludeWifi   # 3. o que vai mudar
.\Set-WillLagLowLatency.ps1 -IncludeWifi -DnsProvider cloudflare  # 4. aplica
.\Get-WillLagReport.ps1            # 5. confere
# ... joga ...
.\Restore-WillLagNetwork.ps1       # 6. desfaz
```

## Se a execução de scripts estiver bloqueada

```powershell
# só para o processo atual, sem mudar a política da máquina
powershell -ExecutionPolicy Bypass -File .\Get-WillLagReport.ps1
```

## Relação com o app

| App (`public/services`) | Script equivalente |
| --- | --- |
| `tcpip.js` (Nagle, MMCSS, netsh global, congestion provider) | `Set-WillLagLowLatency.ps1` (itens 1–5) |
| `wifi.js` (autoconfig, USB suspend, energia do adaptador) | `Set-WillLagLowLatency.ps1 -IncludeWifi` |
| `dnsService.js` | `Set-WillLagLowLatency.ps1 -DnsProvider …` |
| `mtuService.js` | `Set-WillLagLowLatency.ps1 -Mtu …` (a descoberta por busca binária é só no app) |
| `restoreEngine.js` + `stateStore.js` | `Restore-WillLagNetwork.ps1` |
| `netInterfaces.js` + detect() | `Get-WillLagReport.ps1` |

O estado do app fica em `%APPDATA%\willLag\state.json` (backups por tweak,
aplicados, histórico e locks de sessão); os scripts usam
`%APPDATA%\willLag\standalone-backups\`. Eles não se sobrescrevem.
