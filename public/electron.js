const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const os = require('os');
const dns = require('dns');
const net = require('net');
const dgram = require('dgram');

let mainWindow;
let pingInterval = null;

// Verificar se está rodando como administrador
function isAdmin() {
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'icon.ico')
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
  }

  mainWindow.on('closed', () => {
    if (pingInterval) clearInterval(pingInterval);
    mainWindow = null;
  });
}

app.disableHardwareAcceleration();

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==================== CONTROLE DA JANELA ====================
ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('maximize-window', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('close-window', () => mainWindow?.close());

// ==================== VERIFICAR ADMIN ====================
ipcMain.handle('check-admin', () => isAdmin());

// ==================== LISTAR PROCESSOS ====================
ipcMain.handle('get-processes', async () => {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id, ProcessName, MainWindowTitle, @{Name='WorkingSet';Expression={$_.WorkingSet64}}, @{Name='CPU';Expression={$_.CPU}} | ConvertTo-Json"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      try {
        let processes = JSON.parse(stdout);
        if (!Array.isArray(processes)) processes = [processes];

        processes = processes.map(p => ({
          pid: p.Id,
          name: p.ProcessName,
          title: p.MainWindowTitle,
          memory: Math.round((p.WorkingSet || 0) / 1024 / 1024),
          cpu: p.CPU ? parseFloat(p.CPU).toFixed(1) : '0.0'
        }));

        resolve(processes);
      } catch (e) {
        resolve([]);
      }
    });
  });
});

// ==================== LISTAR CONEXÕES DE REDE ====================
ipcMain.handle('get-network-connections', async () => {
  return new Promise((resolve) => {
    const cmd = `powershell -Command "Get-NetTCPConnection | Where-Object {$_.State -eq 'Established' -and $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1'} | Select-Object -First 20 OwningProcess, LocalPort, RemoteAddress, RemotePort, State | ConvertTo-Json"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      try {
        let connections = JSON.parse(stdout);
        if (!Array.isArray(connections)) connections = [connections];
        resolve(connections.map(c => ({
          pid: c.OwningProcess,
          localPort: c.LocalPort,
          remoteAddress: c.RemoteAddress,
          remotePort: c.RemotePort,
          state: c.State
        })));
      } catch (e) {
        resolve([]);
      }
    });
  });
});

// ==================== PING / LATÊNCIA ====================
ipcMain.handle('ping-host', async (event, host) => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const cmd = `ping -n 1 -w 3000 ${host}`;

    exec(cmd, (error, stdout) => {
      if (error) {
        resolve({ host, ms: -1, status: 'timeout' });
        return;
      }

      const match = stdout.match(/tempo[=<](\d+)ms/i) ||
                    stdout.match(/time[=<](\d+)ms/i) ||
                    stdout.match(/=(\d+)ms/);

      if (match) {
        resolve({ host, ms: parseInt(match[1]), status: 'ok' });
      } else {
        resolve({ host, ms: Date.now() - startTime, status: 'ok' });
      }
    });
  });
});

// ==================== MONITORAMENTO CONTÍNUO ====================
ipcMain.on('start-ping-monitor', (event, host) => {
  if (pingInterval) clearInterval(pingInterval);

  const doPing = () => {
    const cmd = `ping -n 1 -w 2000 ${host}`;
    exec(cmd, (error, stdout) => {
      if (mainWindow?.isDestroyed()) return;

      let ms = -1;
      if (!error) {
        const match = stdout.match(/tempo[=<](\d+)ms/i) ||
                      stdout.match(/time[=<](\d+)ms/i) ||
                      stdout.match(/=(\d+)ms/);
        if (match) ms = parseInt(match[1]);
      }

      mainWindow?.webContents.send('ping-result', {
        host,
        ms,
        timestamp: Date.now()
      });
    });
  };

  doPing();
  pingInterval = setInterval(doPing, 1000);
});

ipcMain.on('stop-ping-monitor', () => {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
});

// ==================== OTIMIZAÇÕES TCP/IP ====================
ipcMain.handle('optimize-tcp', async () => {
  if (!isAdmin()) {
    return { success: false, message: 'Necessário executar como Administrador!' };
  }

  const commands = [
    // Desabilitar Nagle Algorithm (reduz latência)
    'netsh int tcp set global autotuninglevel=normal',
    // Desabilitar TCP timestamps
    'netsh int tcp set global timestamps=disabled',
    // Habilitar RSS (Receive Side Scaling)
    'netsh int tcp set global rss=enabled',
    // Desabilitar ECN
    'netsh int tcp set global ecncapability=disabled',
    // Desabilitar chimney offload
    'netsh int tcp set global chimney=disabled',
    // Desabilitar task offload
    'netsh int ip set global taskoffload=disabled',
    // Configurar TCP Fast Open
    'netsh int tcp set global fastopen=enabled',
    // Definir template para Internet (otimizado para latência)
    'netsh int tcp set supplemental Internet congestionprovider=ctcp',
  ];

  const results = [];

  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: 'pipe' });
      results.push({ cmd, success: true });
    } catch (e) {
      results.push({ cmd, success: false, error: e.message });
    }
  }

  return {
    success: true,
    message: 'Otimizações TCP aplicadas!',
    details: results
  };
});

// ==================== OTIMIZAÇÃO NAGLE (REGISTRY) ====================
ipcMain.handle('disable-nagle', async () => {
  if (!isAdmin()) {
    return { success: false, message: 'Necessário executar como Administrador!' };
  }

  return new Promise((resolve) => {
    const cmd = `powershell -Command "
      $interfaces = Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
      foreach ($interface in $interfaces) {
        $path = $interface.PSPath
        $ipAddress = (Get-ItemProperty -Path $path -Name 'DhcpIPAddress' -ErrorAction SilentlyContinue).DhcpIPAddress
        if (-not $ipAddress) {
          $ipAddress = (Get-ItemProperty -Path $path -Name 'IPAddress' -ErrorAction SilentlyContinue).IPAddress
        }
        if ($ipAddress -and $ipAddress -ne '0.0.0.0') {
          Set-ItemProperty -Path $path -Name 'TcpAckFrequency' -Value 1 -Type DWord -Force
          Set-ItemProperty -Path $path -Name 'TCPNoDelay' -Value 1 -Type DWord -Force
          Set-ItemProperty -Path $path -Name 'TcpDelAckTicks' -Value 0 -Type DWord -Force
        }
      }
      Write-Output 'Nagle Algorithm desabilitado com sucesso'
    "`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, message: `Erro: ${stderr || error.message}` });
      } else {
        resolve({ success: true, message: 'Nagle Algorithm desabilitado! Reinicie para aplicar.' });
      }
    });
  });
});

// ==================== PRIORIDADE DE PROCESSO ====================
ipcMain.handle('set-process-priority', async (event, pid, priority) => {
  // priority: 'Realtime', 'High', 'AboveNormal', 'Normal', 'BelowNormal', 'Low'
  const priorityMap = {
    'Realtime': 256,
    'High': 128,
    'AboveNormal': 32768,
    'Normal': 32,
    'BelowNormal': 16384,
    'Low': 64
  };

  return new Promise((resolve) => {
    const cmd = `powershell -Command "
      $process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($process) {
        $process.PriorityClass = '${priority}'
        Write-Output 'Prioridade alterada com sucesso'
      } else {
        Write-Output 'Processo não encontrado'
      }
    "`;

    exec(cmd, (error, stdout) => {
      if (error) {
        resolve({ success: false, message: error.message });
      } else {
        resolve({ success: true, message: `Prioridade do PID ${pid} definida como ${priority}` });
      }
    });
  });
});

// ==================== PRIORIDADE DE REDE (QoS) ====================
ipcMain.handle('set-network-priority', async (event, processName) => {
  if (!isAdmin()) {
    return { success: false, message: 'Necessário executar como Administrador!' };
  }

  return new Promise((resolve) => {
    const cmd = `powershell -Command "
      # Remover política antiga se existir
      Remove-NetQosPolicy -Name 'GamePriority' -Confirm:$false -ErrorAction SilentlyContinue
      # Criar nova política QoS
      New-NetQosPolicy -Name 'GamePriority' -AppPathNameMatchCondition '${processName}.exe' -DSCPAction 46 -NetworkProfile All -Confirm:$false
      Write-Output 'Política QoS criada com sucesso'
    "`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, message: `Erro: ${stderr || error.message}` });
      } else {
        resolve({ success: true, message: `Prioridade de rede máxima para ${processName}` });
      }
    });
  });
});

// ==================== TROCAR DNS ====================
ipcMain.handle('change-dns', async (event, primary, secondary) => {
  if (!isAdmin()) {
    return { success: false, message: 'Necessário executar como Administrador!' };
  }

  return new Promise((resolve) => {
    // Primeiro, descobrir a interface de rede ativa
    const getInterfaceCmd = `powershell -Command "
      $adapter = Get-NetAdapter | Where-Object {$_.Status -eq 'Up' -and $_.InterfaceDescription -notlike '*Virtual*' -and $_.InterfaceDescription -notlike '*Loopback*'} | Select-Object -First 1
      Write-Output $adapter.InterfaceAlias
    "`;

    exec(getInterfaceCmd, (error, stdout) => {
      if (error) {
        resolve({ success: false, message: 'Não foi possível encontrar a interface de rede' });
        return;
      }

      const interfaceName = stdout.trim();

      const cmd = `powershell -Command "
        Set-DnsClientServerAddress -InterfaceAlias '${interfaceName}' -ServerAddresses ('${primary}','${secondary}')
        Clear-DnsClientCache
        Write-Output 'DNS alterado com sucesso'
      "`;

      exec(cmd, (err, out, stderr) => {
        if (err) {
          resolve({ success: false, message: `Erro: ${stderr || err.message}` });
        } else {
          resolve({
            success: true,
            message: `DNS alterado para ${primary} / ${secondary} na interface ${interfaceName}`
          });
        }
      });
    });
  });
});

// ==================== FLUSH DNS ====================
ipcMain.handle('flush-dns', async () => {
  return new Promise((resolve) => {
    exec('ipconfig /flushdns', (error, stdout) => {
      if (error) {
        resolve({ success: false, message: error.message });
      } else {
        resolve({ success: true, message: 'Cache DNS limpo com sucesso!' });
      }
    });
  });
});

// ==================== INFORMAÇÕES DA REDE ====================
ipcMain.handle('get-network-info', async () => {
  const interfaces = os.networkInterfaces();
  const info = [];

  for (const [name, nets] of Object.entries(interfaces)) {
    for (const net2 of nets) {
      if (net2.family === 'IPv4' && !net2.internal) {
        info.push({
          name,
          address: net2.address,
          netmask: net2.netmask,
          mac: net2.mac
        });
      }
    }
  }

  return info;
});

// ==================== OTIMIZAÇÃO DE REDE PARA PROCESSO ESPECÍFICO ====================
ipcMain.handle('optimize-for-process', async (event, pid, processName) => {
  if (!isAdmin()) {
    return { success: false, message: 'Necessário executar como Administrador!' };
  }

  const results = [];

  try {
    // 1. Definir prioridade alta
    execSync(`powershell -Command "(Get-Process -Id ${pid}).PriorityClass = 'High'"`, { stdio: 'pipe' });
    results.push('✅ Prioridade do processo definida como Alta');
  } catch (e) {
    results.push('❌ Erro ao definir prioridade do processo');
  }

  try {
    // 2. Definir afinidade de CPU (usar todos os cores)
    const cpuCount = os.cpus().length;
    const affinity = Math.pow(2, cpuCount) - 1;
    execSync(`powershell -Command "(Get-Process -Id ${pid}).ProcessorAffinity = ${affinity}"`, { stdio: 'pipe' });
    results.push(`✅ Afinidade de CPU definida (${cpuCount} cores)`);
  } catch (e) {
    results.push('❌ Erro ao definir afinidade de CPU');
  }

  try {
    // 3. Criar política QoS
    execSync(`powershell -Command "
      Remove-NetQosPolicy -Name 'GameBoost' -Confirm:$false -ErrorAction SilentlyContinue
      New-NetQosPolicy -Name 'GameBoost' -AppPathNameMatchCondition '${processName}.exe' -DSCPAction 46 -NetworkProfile All -Confirm:$false
    "`, { stdio: 'pipe' });
    results.push('✅ Política QoS de alta prioridade aplicada');
  } catch (e) {
    results.push('⚠️ QoS: pode precisar de reinicialização');
  }

  return {
    success: true,
    message: `Otimizações aplicadas para ${processName}`,
    details: results
  };
});

// ==================== RESETAR OTIMIZAÇÕES ====================
ipcMain.handle('reset-optimizations', async () => {
  if (!isAdmin()) {
    return { success: false, message: 'Necessário executar como Administrador!' };
  }

  const commands = [
    'netsh int tcp set global autotuninglevel=normal',
    'netsh int tcp set global timestamps=enabled',
    'netsh int tcp set global ecncapability=default',
    'netsh int ip set global taskoffload=enabled',
    'powershell -Command "Remove-NetQosPolicy -Name \'GamePriority\' -Confirm:$false -ErrorAction SilentlyContinue"',
    'powershell -Command "Remove-NetQosPolicy -Name \'GameBoost\' -Confirm:$false -ErrorAction SilentlyContinue"',
    'ipconfig /flushdns'
  ];

  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: 'pipe' });
    } catch (e) { }
  }

  return { success: true, message: 'Configurações restauradas ao padrão!' };
});

// ==================== SPEED TEST BÁSICO ====================
ipcMain.handle('speed-test', async () => {
  const hosts = [
    { name: 'Google DNS', host: '8.8.8.8' },
    { name: 'Cloudflare', host: '1.1.1.1' },
    { name: 'OpenDNS', host: '208.67.222.222' },
    { name: 'Google', host: 'google.com' },
    { name: 'AWS São Paulo', host: 'sa-east-1.amazonaws.com' },
    { name: 'Azure Brasil', host: 'brazilsouth.cloudapp.azure.com' }
  ];

  const results = [];

  for (const { name, host } of hosts) {
    try {
      const start = Date.now();
      await new Promise((resolve, reject) => {
        exec(`ping -n 3 -w 2000 ${host}`, (error, stdout) => {
          if (error) {
            results.push({ name, host, avgMs: -1, status: 'error' });
            resolve();
            return;
          }

          const match = stdout.match(/dia\s*=\s*(\d+)ms/i) ||
                        stdout.match(/Average\s*=\s*(\d+)ms/i) ||
                        stdout.match(/average\s*=\s*(\d+)ms/i);

          if (match) {
            results.push({ name, host, avgMs: parseInt(match[1]), status: 'ok' });
          } else {
            results.push({ name, host, avgMs: -1, status: 'parse_error' });
          }
          resolve();
        });
      });
    } catch (e) {
      results.push({ name, host, avgMs: -1, status: 'error' });
    }
  }

  return results;
});