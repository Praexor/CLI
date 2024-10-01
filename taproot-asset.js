require('dotenv').config();
const { Client } = require('ssh2');
const fs = require('fs');
const chalk = require('chalk');
const { program } = require('commander');

// Configuración SSH desde variables de entorno
const sshConfig = {
  host: process.env.SSH_HOST,
  port: parseInt(process.env.SSH_PORT) || 22,
  username: process.env.SSH_USERNAME,
  privateKey: fs.readFileSync(process.env.SSH_PRIVATE_KEY_PATH)
};

// Comandos de Taproot Assets
const commands = {
  listAssets: `tapcli --tlscertpath ${process.env.TAPD_TLS_CERT_PATH} --rpcserver=${process.env.TAPD_RPC_SERVER} --network=${process.env.TAPD_NETWORK} assets list`,
  getAssetInfo: (assetId) => `tapcli --tlscertpath ${process.env.TAPD_TLS_CERT_PATH} --rpcserver=${process.env.TAPD_RPC_SERVER} --network=${process.env.TAPD_NETWORK} assets info ${assetId}`,
  sendAsset: (assetId, amount, recipientAddress) => 
    `tapcli --tlscertpath ${process.env.TAPD_TLS_CERT_PATH} --rpcserver=${process.env.TAPD_RPC_SERVER} --network=${process.env.TAPD_NETWORK} assets send ${assetId} ${amount} --addr=${recipientAddress}`
};

// Función para ejecutar el comando remoto
function executeRemoteCommand(command) {
  return new Promise((resolve, reject) => {
    console.log(chalk.yellow('Ejecutando comando:'), command);
    const conn = new Client();
    conn.on('ready', () => {
      console.log(chalk.green('Conexión SSH establecida'));
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        let output = '';
        stream.on('close', (code, signal) => {
          conn.end();
          if (code !== 0) {
            reject(new Error(`Command failed with exit code ${code}`));
          } else {
            resolve(output);
          }
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          console.error(chalk.red('STDERR:'), data.toString());
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect(sshConfig);
  });
}

// Función para parsear la salida de listAssets
function parseAssetOutput(output) {
  const assets = [];
  const lines = output.split('\n');
  let currentAsset = {};

  for (const line of lines) {
    if (line.includes('"asset_id":')) {
      currentAsset.id = line.split('"')[3];
    } else if (line.includes('"name":')) {
      currentAsset.name = line.split('"')[3];
    } else if (line.includes('"amount":')) {
      currentAsset.supply = line.split('"')[3];
      assets.push(currentAsset);
      currentAsset = {};
    }
  }

  return assets;
}

// Función para listar assets con nombre, supply y asset ID
async function listAssetsNameSupplyAndId() {
  try {
    const result = await executeRemoteCommand(commands.listAssets);
    const assets = parseAssetOutput(result);
    console.log(chalk.blue('Lista de assets (Nombre, Supply y Asset ID):'));
    assets.forEach(asset => {
      console.log(chalk.green(`Nombre: ${asset.name}`));
      console.log(`Supply: ${parseInt(asset.supply).toLocaleString()}`);
      console.log(chalk.yellow(`Asset ID: ${asset.id}`));
      console.log('---');
    });
    return assets;
  } catch (error) {
    console.error(chalk.red('Error al listar los assets:'), error.message);
  }
}

// Función para obtener información detallada de un asset
async function getAssetInfo(assetId) {
  try {
    const result = await executeRemoteCommand(commands.getAssetInfo(assetId));
    console.log(chalk.blue('Información detallada del asset:'));
    console.log(result);
  } catch (error) {
    console.error(chalk.red('Error al obtener información del asset:'), error.message);
  }
}

// Función para buscar assets por nombre
async function searchAssetsByName(name) {
  try {
    const result = await executeRemoteCommand(commands.listAssets);
    const assets = parseAssetOutput(result);
    return assets.filter(asset => 
      asset.name.toLowerCase().includes(name.toLowerCase())
    );
  } catch (error) {
    console.error(chalk.red('Error al buscar assets por nombre:'), error.message);
    return [];
  }
}

// Función para paginar resultados
async function paginateResults(items, pageSize = 10) {
  const inquirer = await import('inquirer');
  let currentPage = 0;

  const displayPage = async () => {
    const startIndex = currentPage * pageSize;
    const endIndex = startIndex + pageSize;
    const pageItems = items.slice(startIndex, endIndex);

    console.log(chalk.blue(`Mostrando ${startIndex + 1}-${Math.min(endIndex, items.length)} de ${items.length} assets:`));
    pageItems.forEach((item, index) => {
      console.log(chalk.green(`${startIndex + index + 1}. ${item.name} (ID: ${item.id})`));
    });

    const { action } = await inquirer.default.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Qué desea hacer?',
        choices: [
          { name: 'Siguiente página', value: 'next', disabled: endIndex >= items.length },
          { name: 'Página anterior', value: 'prev', disabled: currentPage === 0 },
          { name: 'Seleccionar un asset', value: 'select' },
          { name: 'Buscar de nuevo', value: 'search' },
          { name: 'Cancelar', value: 'cancel' }
        ]
      }
    ]);

    switch (action) {
      case 'next':
        currentPage++;
        return displayPage();
      case 'prev':
        currentPage--;
        return displayPage();
      case 'select':
        return selectAsset(pageItems);
      case 'search':
        return null;
      case 'cancel':
        return { cancelled: true };
    }
  };

  return displayPage();
}

// Función para seleccionar un asset de la lista
async function selectAsset(assets) {
  const inquirer = await import('inquirer');
  const { selectedAsset } = await inquirer.default.prompt([
    {
      type: 'list',
      name: 'selectedAsset',
      message: 'Seleccione el asset que desea enviar:',
      choices: assets.map(asset => ({
        name: `${asset.name} (ID: ${asset.id})`,
        value: asset
      }))
    }
  ]);
  return selectedAsset;
}

// Función interactiva para enviar un asset
async function sendAssetInteractive() {
  try {
    const inquirer = await import('inquirer');
    let selectedAsset = null;

    while (!selectedAsset) {
      const { searchTerm } = await inquirer.default.prompt([
        {
          type: 'input',
          name: 'searchTerm',
          message: 'Ingrese el nombre del asset a buscar (o deje en blanco para ver todos):',
        }
      ]);

      let assets;
      if (searchTerm.trim() === '') {
        const result = await executeRemoteCommand(commands.listAssets);
        assets = parseAssetOutput(result);
      } else {
        assets = await searchAssetsByName(searchTerm);
      }

      if (assets.length === 0) {
        console.log(chalk.yellow('No se encontraron assets. Intente de nuevo.'));
        continue;
      }

      const result = await paginateResults(assets);
      if (result && result.cancelled) {
        console.log(chalk.yellow('Operación cancelada.'));
        return;
      }
      selectedAsset = result;
    }

    const { amount, recipientAddress, confirm } = await inquirer.default.prompt([
      {
        type: 'input',
        name: 'amount',
        message: 'Ingrese la cantidad a enviar:',
        validate: input => !isNaN(input) && parseInt(input) > 0 || 'Por favor ingrese un número entero válido mayor que 0'
      },
      {
        type: 'input',
        name: 'recipientAddress',
        message: 'Ingrese la dirección del destinatario:',
        validate: input => input.trim() !== '' || 'La dirección del destinatario no puede estar vacía'
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: '¿Está seguro de que desea enviar este asset?',
        default: false
      }
    ]);

    if (confirm) {
      console.log(chalk.yellow('Enviando asset...'));
      console.log(chalk.yellow(`Asset ID: ${selectedAsset.id}`));
      console.log(chalk.yellow(`Cantidad: ${amount}`));
      console.log(chalk.yellow(`Dirección: ${recipientAddress}`));

      const command = commands.sendAsset(selectedAsset.id, amount, recipientAddress);
      console.log(chalk.blue('Comando a ejecutar:'), command);

      try {
        const result = await executeRemoteCommand(command);
        console.log(chalk.green('Respuesta del comando:'));
        console.log(result);
        
        if (result.includes("NAME:") && result.includes("USAGE:")) {
          console.log(chalk.red('El comando no se ejecutó correctamente. Mostrando información de uso.'));
          console.log(chalk.yellow('Asegúrese de que tiene los permisos necesarios y que los parámetros son correctos.'));
        }
      } catch (error) {
        console.error(chalk.red('Error al ejecutar el comando:'), error.message);
      }
    } else {
      console.log(chalk.yellow('Operación cancelada.'));
    }
  } catch (error) {
    console.error(chalk.red('Error al enviar el asset:'), error.message);
  }
}

// Configuración de la interfaz de línea de comandos
program
  .version('1.0.0')
  .description('CLI para interactuar con Taproot Assets');

program
  .command('list')
  .description('Listar todos los assets con su nombre, supply y asset ID')
  .action(listAssetsNameSupplyAndId);

program
  .command('info <assetId>')
  .description('Obtener información detallada de un asset específico')
  .action(getAssetInfo);

program
  .command('search <name>')
  .description('Buscar assets por nombre')
  .action(async (name) => {
    const assets = await searchAssetsByName(name);
    if (assets.length > 0) {
      console.log(chalk.blue(`Assets encontrados con el nombre "${name}":`));
      assets.forEach(asset => {
        console.log(chalk.green(`Nombre: ${asset.name}`));
        console.log(`Supply: ${parseInt(asset.supply).toLocaleString()}`);
        console.log(chalk.yellow(`Asset ID: ${asset.id}`));
        console.log('---');
      });
    } else {
      console.log(chalk.yellow(`No se encontraron assets con el nombre "${name}".`));
    }
  });

program
  .command('send')
  .description('Enviar un asset a otra wallet (interactivo)')
  .action(sendAssetInteractive);

program.parse(process.argv);

// Si no se proporciona ningún comando, mostrar la ayuda
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
