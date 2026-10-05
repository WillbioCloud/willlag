# willLag — referência técnica dos ajustes

Este documento descreve **exatamente** o que cada ajuste faz, em qual chave/comando,
qual é o valor padrão do Windows e como desfazer. Se um texto de UI e este
documento divergirem, este documento (e o código em `public/services/`) é a
fonte de verdade — e a divergência é um bug a reportar.

O catálogo consumido pela interface (`src/shared/tweakCatalog.json`) é
**gerado** a partir do código:

```bash
npm run sync-catalog          # regenera
npm run sync-catalog:check    # falha se estiver desatualizado (CI)
```

---

## 1. Modelo de segurança

Toda alteração passa por três etapas, sem exceção:

1. **Detectar** — lê o estado real (registro, `netsh`, `powercfg`, CIM). Se o
   recurso não existe no sistema (ex.: Chimney Offload em Windows 11), o ajuste
   é marcado como *não suportado* e a UI desabilita a ação. Nada é "chutado".
2. **Fazer backup** — antes de escrever, o valor anterior é gravado em
   `%APPDATA%\willLag\state.json` **incluindo o caso "o valor não existia"**.
   Restaurar um valor inexistente significa *remover* a entrada, não zerá-la.
   Até 5 camadas por ajuste (`MAX_BACKUP_LAYERS`), consumidas como pilha: aplicar
   duas vezes não sobrescreve o valor original.
3. **Aplicar e conferir** — depois de escrever, o módulo relê o sistema e só
   reporta sucesso se o valor alvo estiver de fato lá. Falha de elevação
   (UAC negado) **não** consome o backup.

Reversão:

* por ajuste (`revert-tweak`), por preset (`revert-tweaks`) ou tudo
  (`revert-all`) — sempre a partir do backup;
* `restoreEngine.js` gera **um único script PowerShell** com todas as entradas
  (menos round-trips de UAC) e aceita 12 tipos de entrada
  (`registry`, `netshGlobal`, `netshIpGlobal`, `netshSupplemental`,
  `wlanAutoconfig`, `powercfgAcDc`, `adapterPowerManagement`, `adapterAdvanced`,
  `dns`, `mtu`, `qosPolicy`, `service`);
* sem app: [`scripts/Restore-WillLagNetwork.ps1`](../scripts/README.md).

Ajustes de **sessão** (hoje, só `wlanAutoconfig`) têm tratamento extra: são
revertidos ao pausar o Modo Jogo, ao fechar o app, em `uncaughtException`,
`SIGINT`/`SIGTERM`, e por um *watchdog* que testa gateway+internet. Se a
reversão falhar no encerramento, o app imprime no log o comando exato
(`netsh wlan set autoconfig enabled=yes interface="X"`) em vez de silenciar.

---

## 2. Catálogo


### 🧠 Pilha TCP/IP e Registro — `tcpip`

| id | Ajuste | Risco | Escopo | Admin | Ultra | Opções |
| --- | --- | --- | --- | --- | --- | --- |
| `nagle` | Desativar Nagle's Algorithm (TCP_NODELAY) | Baixo risco | persistente | sim | ✅ | `Somente a interface ativa (recomendado)`<br>`Todas as interfaces com IP` |
| `networkThrottling` | Desativar Network Throttling (MMCSS) | Baixo risco | persistente | sim | ✅ | — |
| `systemResponsiveness` | System Responsiveness = 0 (100% para o jogo) | Risco médio | persistente | sim | ✅ | `0`<br>`10`<br>`20` |
| `mmcssGames` | Priorizar tarefas MMCSS de jogos | Baixo risco | persistente | sim | ✅ | — |
| `autoTuning` | TCP Auto-Tuning = normal | Baixo risco | persistente | sim | ✅ | `normal`<br>`disabled`<br>`restricted`<br>`highlyrestricted`<br>`experimental` |
| `ecn` | Desativar ECN Capability | Baixo risco | persistente | sim | ✅ | `disabled`<br>`enabled`<br>`default` |
| `tcpFastOpen` | TCP Fast Open (TFO) | Baixo risco | persistente | sim | ✅ | — |
| `rss` | Receive Side Scaling (RSS) | Baixo risco | persistente | sim | ✅ | — |
| `congestionProvider` | Provedor de congestionamento (CTCP / CUBIC) | Risco médio | persistente | sim | ✅ | `auto`<br>`ctcp`<br>`cubic` |
| `rsc` | Desativar Receive Segment Coalescing (RSC) | Risco médio | persistente | sim | — | `disabled`<br>`enabled` |
| `timestamps` | Desativar RFC 1323 Timestamps | Risco médio *(legado)* | persistente | sim | — | `disabled`<br>`enabled` |
| `initialRto` | Initial RTO = 1000ms | Baixo risco | persistente | sim | — | `1000`<br>`2000`<br>`3000` |
| `chimneyOffload` | Chimney Offload = disabled (legado) | Baixo risco *(legado)* | persistente | sim | — | — |
| `qosReservedBandwidth` | Liberar banda reservada por QoS (Psched) | Baixo risco | persistente | sim | — | — |

### 📶 Wi-Fi e energia USB — `wifi`

| id | Ajuste | Risco | Escopo | Admin | Ultra | Opções |
| --- | --- | --- | --- | --- | --- | --- |
| `wlanAutoconfig` | Pausar varredura de redes em segundo plano (WLAN AutoConfig) | Risco médio | **sessão** | sim | ✅ | — |
| `usbSelectiveSuspend` | Desativar USB Selective Suspend | Baixo risco | persistente | sim | ✅ | — |
| `adapterPowerManagement` | Desativar economia de energia do adaptador de rede | Baixo risco | persistente | sim | ✅ | — |
| `adapterPowerSaveAdvanced` | Desativar economia de energia no driver (propriedades avançadas) | Risco médio | persistente | sim | — | — |

### 🌐 DNS — `dns`

| id | Ajuste | Risco | Escopo | Admin | Ultra | Opções |
| --- | --- | --- | --- | --- | --- | --- |
| `autoDns` | DNS automático de menor latência e jitter | Baixo risco | persistente | sim | ✅ | `cloudflare`<br>`cloudflare-malware`<br>`cloudflare-family`<br>`google`<br>`quad9`<br>`opendns`<br>`adguard`<br>`level3`<br>`auto`<br>`dhcp` |

### 🧭 Roteamento e MTU — `routing`

| id | Ajuste | Risco | Escopo | Admin | Ultra | Opções |
| --- | --- | --- | --- | --- | --- | --- |
| `mtuOptimize` | MTU ideal (evitar fragmentação UDP) | Risco médio | persistente | sim | — | — |

### Presets

| Preset | Ajustes | Conteúdo |
| --- | --- | --- |
| `ultra` — Modo Ultra Low-Latency | 13 | `nagle`, `networkThrottling`, `systemResponsiveness`, `mmcssGames`, `autoTuning`, `ecn`, `tcpFastOpen`, `rss`, `congestionProvider`, `wlanAutoconfig`, `usbSelectiveSuspend`, `adapterPowerManagement`, `autoDns` |
| `safe` — Conservador (baixo risco) | 10 | `nagle`, `networkThrottling`, `mmcssGames`, `autoTuning`, `ecn`, `tcpFastOpen`, `rss`, `usbSelectiveSuspend`, `adapterPowerManagement`, `autoDns` |
| `wifi` — Só Wi-Fi / USB | 4 | `wlanAutoconfig`, `usbSelectiveSuspend`, `adapterPowerManagement`, `adapterPowerSaveAdvanced` |
| `all` — Tudo | 20 | `nagle`, `networkThrottling`, `systemResponsiveness`, `mmcssGames`, `autoTuning`, `ecn`, `tcpFastOpen`, `rss`, `congestionProvider`, `rsc`, `timestamps`, `initialRto`, `chimneyOffload`, `qosReservedBandwidth`, `wlanAutoconfig`, `usbSelectiveSuspend`, `adapterPowerManagement`, `adapterPowerSaveAdvanced`, `autoDns`, `mtuOptimize` |
| `legacy` — Compatibilidade (versão anterior) | 7 | `autoTuning`, `timestamps`, `rss`, `ecn`, `chimneyOffload`, `congestionProvider`, `tcpFastOpen` |

---

## 3. Detalhe por ajuste

### `nagle` — Desativar o algoritmo de Nagle

| | |
| --- | --- |
| Onde | `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}` |
| Aplica | `TcpAckFrequency = 1` (DWORD), `TCPNoDelay = 1` (DWORD), `TcpDelAckTicks = 0` (DWORD) |
| Padrão Windows | os três valores **não existem** na chave |
| Reverte | remove/restaura exatamente o que havia (backup por GUID) |
| Alvo | só interfaces **com IP** (as que o jogo usa); opção *todas as interfaces* na UI |
| Efeito | pacote pequeno sai na hora, sem esperar ACK nem acumular |

Pacotes de jogo têm 40–120 bytes e são enviados 20–60× por segundo: o pior caso
para Nagle + delayed ACK, que juntos podem segurar o pacote por 40–200 ms.

> Nagle **não** é o vilão universal que alguns guias pintam: em TCP bulk
> (downloads) ele ajuda. Por isso o willLag registra *por interface* e permite
> reverter uma a uma.

### `networkThrottling` — Desativar o limitador de pacotes não-multimídia

| | |
| --- | --- |
| Onde | `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile` |
| Aplica | `NetworkThrottlingIndex = 0xffffffff` (DWORD) |
| Padrão Windows | `0x0000000a` (10) |
| Reverte | `10` |

Com uma sessão MMCSS ativa (jogo, Discord, player de áudio), o Windows limita o
tráfego de rede *não* multimídia a 10 pacotes/ms. Em jogos de tick rate alto com
voice chat simultâneo isso aparece como micro-stall. `0xffffffff` remove o teto.

> Detalhe de implementação: em .NET o DWORD `0xffffffff` é o `Int32` `-1`.
> Escrever `4294967295` direto estoura a conversão — o código usa `-1` e **relê**
> o valor para confirmar que ficou `0xffffffff`.

### `systemResponsiveness` — Reserva de CPU do MMCSS

| | |
| --- | --- |
| Onde | mesma chave de `networkThrottling` |
| Aplica | `SystemResponsiveness = 0` (opções: `0`, `10`, `20`) |
| Padrão Windows | `20` |
| Reverte | `20` |

`20` reserva 20% da CPU para tarefas de segundo plano durante sessões
multimídia. `0` entrega tudo ao jogo. **Risco médio**: se você faz stream/
gravação ou mantém downloads pesados enquanto joga, `10` costuma ser melhor — a
UI expõe as três opções e salva a escolha.

### `mmcssGames` — Prioridade da tarefa MMCSS "Games"

| | |
| --- | --- |
| Onde | `...\Multimedia\SystemProfile\Tasks\Games` |
| Aplica | `GPU Priority = 8`, `Priority = 6`, `Scheduling Category = "High"`, `SFIO Priority = "High"` |
| Padrão Windows | `1`, `1`, `Medium`, `Normal` |
| Reverte | os quatro padrões (ou remove a chave, se não existia) |

É o que o agendador multimídia usa para priorizar threads de jogo, incluindo
prioridade de GPU e de E/S.

### `autoTuning` — Janela de recepção dinâmica

`netsh int tcp set global autotuninglevel=normal` — **`normal` é o recomendado
pela Microsoft** e o padrão do Windows 10/11. O ajuste existe porque "otimizadores"
de terceiros frequentemente gravam `disabled` (janela fixa de 64 KB), o que
*derruba* o throughput e aumenta o tempo de download de patch. Se o seu sistema
está em `disabled`, este ajuste é uma **correção**, não um ganho marginal.

Opções: `normal`, `disabled`, `restricted`, `highlyrestricted`, `experimental`.

### `ecn` — Explicit Congestion Notification

`netsh int tcp set global ecncapability=disabled` (padrão do Windows já é
`disabled`). Fica no catálogo porque roteadores/CGNAT antigos reagem mal a ECN
negociado, causando timeout de conexão; se o seu caminho é moderno e estável,
`enabled` pode ajudar em enlaces congestionados — daí a opção.

### `tcpFastOpen` — TCP Fast Open

`netsh int tcp set global fastopen=enabled`. Permite enviar dados já no SYN,
economizando 1 RTT na abertura de conexão. Ajuda em HTTP(S)/patches e em clientes
de jogo que abrem várias conexões curtas; não muda o ping de uma sessão UDP já
estabelecida.

### `rss` — Receive Side Scaling

`netsh int tcp set global rss=enabled`. Distribui o processamento de pacotes
entre núcleos. Desativar RSS concentra tudo num núcleo e **aumenta** jitter em
PCs com várias placas/rede rápida — por isso o alvo é `enabled`.

### `rsc` — Receive Segment Coalescing *(fora do preset ultra)*

`netsh int tcp set global rsc=disabled`. RSC agrega vários pacotes recebidos
antes de entregá-los à pilha: ótimo para throughput, péssimo para latência de
jogos em tempo real. **Risco médio**: pode aumentar o uso de CPU e reduzir a
vazão em downloads.

### `timestamps` — RFC 1323 Timestamps *(legado)*

`netsh int tcp set global timestamps=disabled`. Remove 12 bytes de overhead por
pacote TCP. Marcado como **legado**: em Windows 8+ timestamps também alimentam a
medição de RTT do auto-tuning, então desativar pode *piorar* a estimativa. Só
aparece no preset `legacy`.

### `initialRto` — Timeout inicial de retransmissão *(fora do preset ultra)*

`netsh int tcp set global initialrto=1000` (padrão `3000`). Reduz o tempo da
primeira retransmissão quando o SYN inicial se perde — útil em Wi-Fi ruim. Em
enlaces com perda real, um RTO curto demais pode gerar retransmissões
desnecessárias; por isso as opções incluem `2000` e `3000`.

### `chimneyOffload` — TCP Chimney *(legado, não suportado)*

`netsh int tcp set global chimney=disabled`. **Removido do Windows a partir do
build 9200 (Windows 8)**: em sistemas modernos o willLag marca como *não
suportado* e a UI desabilita a linha. Mantido só para quem ainda roda Windows 7.

### `qosReservedBandwidth` — Banda reservada do Psched *(fora do preset ultra)*

| | |
| --- | --- |
| Onde | `HKLM\SOFTWARE\Policies\Microsoft\Windows\Psched` |
| Aplica | `NonBestEffortLimit = 0` (DWORD) |
| Padrão Windows | valor inexistente ⇒ 20% efetivos |
| Reverte | remove o valor |

Libera a parcela que o agendador de pacotes pode reservar. Em conexões
domésticas o efeito é pequeno; em enlaces saturados (download + jogo) evita que
o tráfego do jogo fique atrás da reserva.

### `congestionProvider` — CTCP ou CUBIC *(só se suportado)*

`netsh int tcp set supplemental Internet congestionprovider=ctcp`

* o willLag lê `netsh int tcp show supplemental` e **só** aplica o provedor se
  ele estiver listado para o template `Internet`;
* `auto` (padrão) escolhe `ctcp` quando disponível e, caso contrário, **não mexe**;
* **BBR não existe na pilha nativa do Windows.** O willLag nunca promete ativá-lo
  — só detecta se algum build/patch o expõe;
* revert = `cubic` (padrão do Windows 10/11) ou o valor capturado no backup.

CTCP sobe a janela mais rápido (bom para download de patch), mas em enlace
saturado pode gerar bufferbloat → jitter. Se o seu problema é *instabilidade* e
não velocidade, deixe `cubic`.

### `wlanAutoconfig` — Pausar a varredura de redes Wi-Fi (**sessão**)

```
netsh wlan set autoconfig enabled=no interface="Wi-Fi"
```

É **a** correção do sintoma "ping sobe a cada 30–60 segundos em adaptador Wi-Fi
(ainda mais em dongle USB)": para procurar redes melhores, o rádio sai do canal
atual e os pacotes do jogo ficam na fila do driver.

| | |
| --- | --- |
| Escopo | **sessão** (`sessionCritical: true`) |
| Custo | o Windows **não reconecta sozinho** se a conexão cair |
| Guarda | logo após pausar, o willLag testa o gateway; sem resposta, reativa na hora |
| Watchdog | conectividade revalidada a cada 15 s; 3 falhas seguidas ⇒ rollback |
| Encerramento | revertido em `before-quit`, `SIGINT`/`SIGTERM`, `uncaughtException`; se falhar, o log imprime o comando exato |
| Reverte | `netsh wlan set autoconfig enabled=yes interface="Wi-Fi"` |

### `usbSelectiveSuspend` — Energia de portas USB

```
powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
powercfg /setdcvalueindex SCHEME_CURRENT <idem> 0
powercfg /setactive SCHEME_CURRENT
```

Dongle Wi-Fi USB que entra em suspensão seletiva reaparece como *spike* de
centenas de ms ou como desconexão do adaptador. Backup guarda os índices AC/DC
anteriores (lidos de `powercfg /q`, com rótulos em pt-BR *e* en-US).

### `adapterPowerManagement` — "O computador pode desligar este dispositivo"

Via `Set-NetAdapterPowerManagement`, nas propriedades que o adaptador suportar:

`AllowComputerToTurnOffDevice=Disabled`, `DeviceSleepOnDisconnect=Disabled`,
`SelectiveSuspend=Disabled`, `D0PacketCoalescing=Disabled`,
`PMWiFiRekeyOffload=Disabled`

Complemento por `root\WMI` (`MSPower_DeviceEnable`) — é a mesma caixa do
Gerenciador de Dispositivos, para drivers que não expõem tudo pelo cmdlet.
Reverte com `Enable-NetAdapterPowerManagement` + valores do backup.

### `adapterPowerSaveAdvanced` — Propriedades avançadas do driver *(fora do preset ultra)*

`Set-NetAdapterAdvancedProperty -RegistryKeyword … -RegistryValue …` nas
propriedades cujo nome indica economia de energia: *Power Saving Mode*,
*U-APSD support*, *Advanced EEE*, *Energy Efficient Ethernet*, *Green Ethernet*,
*Device Sleep on Disconnect*, *Economia de Energia*, etc.

Os nomes e valores variam por fabricante (Realtek/Intel/Atheros/Qualcomm), então
o willLag **enumera os valores válidos do próprio driver** e escolhe o que
significa "menos economia": `Disabled` > `No Power Save` > `Low Power Saving` >
`Medium`… — e nunca grava um valor que o driver não liste. *Roaming
Aggressiveness* é tratado à parte (baixo = menos varredura).

### `autoDns` — DNS de menor latência **e jitter**

Medição em três camadas, porque cada uma falha de um jeito:

1. **TCP/53 handshake** — latência de rede até o resolvedor (ICMP costuma ser
   despriorizado ou bloqueado em `1.1.1.1`/`8.8.8.8`);
2. **consulta DNS real** (c-ares, UDP/53) contra `www.google.com`,
   `store.steampowered.com`, `cloudflare.com`, `www.roblox.com` — é o que o
   sistema de fato paga;
3. **ICMP** (opcional) — comparabilidade com `ping`/`tracert`.

Score combinado (menor é melhor): média ponderada
`0.35·rede + 0.55·resolução + 0.10·icmp` sobre `avg`, `p95`, `jitter`, `stddev`
e `lossPercent` (perda pesa 40× no score). Priorizar **estabilidade** em vez de
média é deliberado: de nada adianta resolver em 5 ms se 1 em 20 consultas leva
900 ms.

Aplicação: `Set-DnsClientServerAddress -InterfaceIndex <ifIndex> -ServerAddresses @(...)`
seguido de `Clear-DnsClientCache` + `ipconfig /flushdns`. Backup guarda os
servidores anteriores **e se era DHCP** (`ResetServerAddresses` no revert).

> **Honestidade:** DNS não reduz o ping dentro da partida — o jogo conecta por
> IP depois do matchmaking. O ganho real é em login, matchmaking, loja, download
> de patch e anti-cheat, e principalmente em *evitar* travadas de 2–5 s por
> timeout de resolução. A UI diz isso explicitamente.

### `mtuOptimize` — MTU do caminho (sem fragmentação UDP)

Descoberta por **busca binária** com `ping -f -l <payload>` (`-f` = não
fragmentar): o maior payload que passa sem fragmentar + 28 bytes de cabeçalho
IP+ICMP é o MTU do caminho. Mede o gateway (enlace local) e alvos de internet
(caminho real, incluindo PPPoE/VPN/CGNAT) e recomenda o menor deles.

* payload válido: `MIN_PAYLOAD`..`MAX_PAYLOAD` (548..8972);
* `hasMonotonicityViolation()` detecta medição ruidosa (um payload **menor** que
  o maior que já passou, marcado como falha) e avisa o usuário em vez de
  recomendar um número em que não confia;
* aplica com `netsh interface ipv4 set subinterface <ifIndex> mtu=<valor> store=persistent`
  e **relembra** o MTU anterior no backup;
* valores típicos: `1500` Ethernet, `1492` PPPoE, `1400–1460` VPN/hotspot.

MTU maior que o do caminho ⇒ fragmentação ou queda de pacotes UDP do jogo
(sintoma: hits não registram, "teleporte" do personagem).

---

## 4. O que o willLag **não** faz

* **BBR** — não existe na pilha nativa do Windows; só é aplicado se o sistema
  realmente o listar em `netsh int tcp show supplemental`.
* **Desativar Windows Defender / Firewall / Update** — não reduz latência de
  forma mensurável e cria risco real. Nenhum preset toca em serviços de
  segurança.
* **Matar processos do sistema** — a aba *Processos* ajusta prioridade
  (`set-process-priority`) apenas do que você escolher, e a UI usa a escala real
  do Windows (`Idle`, `BelowNormal`, `Normal`, `AboveNormal`, `High`); `Realtime`
  é recusado de propósito (pode travar entrada de mouse/teclado).
* **Timer resolution / "game boosters" de kernel** — efeito marginal, risco de
  instabilidade.
* **Qualquer coisa no roteador** — o app é 100% local. QoS do roteador costuma
  ajudar mais que qualquer ajuste de SO; a UI recomenda isso nas dicas.
* **Chimney/Timestamps em Windows moderno** — marcados como legado e
  automaticamente *não suportados* em build ≥ 9200.

---

## 5. Códigos de resultado

Toda operação devolve `{ success, code, applied, message, … }`. Códigos:

`OK`, `PARTIAL`, `NOTHING_TO_RESTORE`, `TIMEOUT`, `UAC_DENIED`, `ACCESS_DENIED`,
`ELEVATION_REQUIRED`, `UNSUPPORTED`, `UNSUPPORTED_PLATFORM`, `INVALID_PARAMETER`,
`INVALID_INTERFACE`, `INVALID_DNS`, `NO_INTERFACE`, `NO_ADAPTER`, `NOT_FOUND`,
`EXEC_FAILED`, `NO_RESULT`, `BAD_RESULT`, `TEMP_WRITE_FAILED`, `NETSH_FAILED`,
`ALREADY_SET`, `ALREADY_ACTIVE`, `NOT_ACTIVE`, `NO_BACKUP`, `UNKNOWN_TWEAK`.

`UAC_DENIED` e `ELEVATION_REQUIRED` nunca consomem backup nem deixam alteração
parcial: a UI mostra o aviso *"Permissão negada (UAC) — nada foi alterado"* e o
botão **Reiniciar como Administrador**.

---

## 6. Sintoma → ajuste

| Sintoma | Comece por |
| --- | --- |
| Ping sobe ~50–200 ms a cada 30–60 s (Wi-Fi/dongle USB) | `wlanAutoconfig` + `usbSelectiveSuspend` + `adapterPowerManagement` (preset `wifi`) |
| Delay de tiro / movimento "preso" em jogos rápidos | `nagle` + `networkThrottling` + `rsc` |
| Travada de 2–5 s ao entrar em loja, matchmaking ou baixar patch | `autoDns` + `tcpFastOpen` |
| Micro-stall com Discord/voice aberto | `networkThrottling` + `mmcssGames` + `systemResponsiveness` |
| Hits não registram / personagem "teleporta" | `mtuOptimize` (busca binária) |
| Queda de vazão depois de usar outro "otimizador" | `autoTuning=normal` + `rss=enabled` + relatório `Get-WillLagReport.ps1` |
| Instabilidade/queda de conexão ao aplicar tudo | preset `safe`, depois reintroduza um por um |
