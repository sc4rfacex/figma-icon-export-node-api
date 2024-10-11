#!/usr/bin/env node

const defaults = require('./src/defaults');
const figma = require('./src/figma-client');
const fs = require('fs');
const path = require('path');
const ora = require('ora');
const chalk = require('chalk');
const ui = require('cliui')({ width: 80 });
const axios = require('axios');
const prompts = require('prompts');
const promptsList = require('./src/prompts');
const mkdirp = require('mkdirp');
const argv = require('minimist')(process.argv.slice(2));
let config = {};
let figmaClient;
const spinner = ora();

function deleteConfig() {
  const configFile = path.resolve(defaults.configFileName);
  if (fs.existsSync(configFile)) {
    fs.unlinkSync(configFile);
    console.log(chalk.cyan.bold('Deleted previous config'));
  }
}

function updateGitIgnore() {
  const ignorePath = '.gitignore';
  const configPath = argv.config || defaults.configFileName;
  const ignoreCompletePath = path.resolve(ignorePath);
  if (fs.existsSync(configPath)) {
    const ignoreContent = `\n#figma-export-icons\n${configPath}`;
    const ignore = fs.existsSync(ignoreCompletePath)
      ? fs.readFileSync(ignoreCompletePath, 'utf-8')
      : '';
    if (!ignore.includes(ignoreContent)) {
      fs.writeFileSync(ignoreCompletePath, ignore + ignoreContent);
      console.log(`Updated ${ignorePath} : ${ignoreContent}`);
    }
  }
}

function getConfig() {
  return new Promise((resolve) => {
    const configFile = path.resolve(argv.config || defaults.configFileName);
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const missingConfig = promptsList.filter((q) => !config[q.name]);
      if (missingConfig.length > 0)
        getPromptData(missingConfig).then(() => resolve());
      else resolve();
    } else {
      getPromptData().then(() => resolve());
    }
  });
}

async function getPromptData(list = promptsList) {
  const onCancel = (prompt) => {
    process.exit(1);
  };
  const response = await prompts(list, { onCancel });
  config = Object.assign(config, response);
  fs.writeFileSync('icons-config.json', JSON.stringify(config, null, 2));
}

function createOutputDirectory() {
  return new Promise((resolve) => {
    const directory = path.resolve(config.iconsPath);
    if (!fs.existsSync(directory)) {
      console.log(`Directory ${config.iconsPath} does not exist`);
      if (mkdirp.sync(directory)) {
        console.log(`Created directory ${config.iconsPath}`);
        resolve();
      }
    } else {
      resolve();
    }
  });
}

function deleteIcon(iconPath) {
  return new Promise((resolve) => {
    fs.unlink(iconPath, (err) => {
      if (err) throw err;
      // if no error, file has been deleted successfully
      resolve();
    });
  });
}

function deleteDirectory(directory) {
  return new Promise((resolve) => {
    fs.rmdir(directory, (err) => {
      if (err) throw err;
      resolve();
    });
  });
}

function deleteIcons() {
  return new Promise((resolve, reject) => {
    const directory = path.resolve(config.iconsPath);

    spinner.start('Deleting directory contents');

    // Usar fs.promises.rm para eliminar el directorio completo de manera recursiva
    fs.promises
      .rm(directory, { recursive: true, force: true })
      .then(() => {
        spinner.succeed('Directory contents deleted successfully.');
        resolve();
      })
      .catch((err) => {
        spinner.fail('Failed to delete directory contents.');
        console.error(
          `Error al eliminar el contenido del directorio: ${err.message}`
        );
        reject(err);
      });
  });
}
function findDuplicates(propertyName, arr) {
  return arr.reduce((acc, current) => {
    const x = acc.find((item) => item[propertyName] === current[propertyName]);
    if (x) {
      spinner.fail(
        chalk.bgRed.bold(
          `Duplicate icon name: ${x[propertyName]}. Please fix figma file`
        )
      );
      current[propertyName] = current[propertyName] + '-duplicate-name';
    }
    return acc.concat([current]);
  }, []);
}

function getPathToFrame(root, current) {
  if (!current.length) return root;
  const path = [...current];
  const name = path.shift();
  const foundChild = root.children.find((c) => c.name === name);
  if (!foundChild) return root;
  return getPathToFrame(foundChild, path);
}

function getFigmaFile() {
  return new Promise((resolve) => {
    spinner.start(
      'Fetching Figma file (this might take a while depending on the figma file size)'
    );
    figmaClient
      .get(`/files/${config.fileId}`)
      .then((res) => {
        spinner.succeed();
        const page = res.data.document.children.find(
          (c) => c.name === config.page
        );
        if (!page) {
          console.log(
            chalk.red.bold('Cannot find Icons Page, check your settings')
          );
          return;
        }

        // Modificación: recorrer en profundidad para obtener todos los nodos
        let iconsArray = [];
        // Función recursiva para recorrer todos los nodos dentro de una categoría
        function traverseNodes(node, parentCategory = '') {
          if (node.children) {
            node.children.forEach((child) => {
              const currentCategory = parentCategory || node.name;

              if (child.type === 'COMPONENT' || child.type === 'INSTANCE') {
                iconsArray.push({
                  id: child.id,
                  name: child.name,
                  path: node.name,
                  category: currentCategory, // Asignar categoría a cada ícono
                });
              }
              traverseNodes(child, currentCategory);
            });
          }
        }
        // Iniciar la búsqueda de nodos a partir de la página principal
        traverseNodes(page);

        // Verificar si se encontraron íconos
        if (iconsArray.length === 0) {
          console.log(chalk.red.bold('No icons found in the specified page.'));
          process.exit(1);
        }

        // Eliminar nombres duplicados
        let icons = findDuplicates('name', iconsArray);

        resolve(icons);
      })
      .catch((err) => {
        spinner.fail();
        console.log('Cannot get Figma file: ', err);
        process.exit(1);
      });
  });
}
function getImages(icons) {
  return new Promise((resolve) => {
    spinner.start('Fetching icon urls');
    const iconIds = icons.map((icon) => icon.id).join(',');
    figmaClient
      .get(`/images/${config.fileId}?ids=${iconIds}&format=svg`)
      .then((res) => {
        spinner.succeed();
        const images = res.data.images;
        icons.forEach((icon) => {
          icon.image = images[icon.id];
        });
        resolve(icons);
      })
      .catch((err) => {
        console.log('Cannot get icons: ', err);
        process.exit(1);
      });
  });
}

function downloadImage(url, name, category) {
  console.log(`Downloading ${name} from ${url} Categoria ${category}`);
  // Validar el nombre del ícono y la categoría antes de crear la ruta
  const cleanName = removeFromName(name); // Limpiar el nombre antes de usarlo
  if (!cleanName || !category) {
    console.error(
      `Invalid arguments received. Name: ${cleanName}, Category: ${category}`
    );
    return Promise.reject(new Error('Invalid path arguments'));
  }

  // Crear la estructura de directorios correctamente
  let directory = path.join(config.iconsPath, category); // Incluir categoría

  // Crear directorio si no existe
  if (!fs.existsSync(directory)) {
    mkdirp.sync(directory);
    console.log(`Created directory ${directory}`);
  }

  // Construir la ruta completa del archivo SVG
  const imagePath = path.resolve(directory, `${cleanName}.svg`);
  const writer = fs.createWriteStream(imagePath);

  // Descargar la imagen y guardarla
  return axios
    .get(url, { responseType: 'stream' })
    .then((res) => {
      res.data.pipe(writer);
    })
    .catch((err) => {
      console.error('Error al descargar la imagen:', err.message);
      console.log('URL:', url);
      return Promise.reject(new Error('Error al descargar la imagen'));
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          resolve({
            name: `${cleanName}.svg`,
            size: fs.statSync(imagePath).size,
          });
        });
        writer.on('error', (err) => {
          console.error('Error al escribir el archivo', err);
          reject(err);
        });
      });
    });
}

function makeRow(a, b) {
  return `  ${a}\t    ${b}\t`;
}

function formatSize(size) {
  return (size / 1024).toFixed(2) + ' KiB';
}

function makeResultsTable(results) {
  ui.div(
    makeRow(chalk.cyan.bold(`File`), chalk.cyan.bold(`Size`)) +
      `\n\n` +
      results
        .map((asset) =>
          makeRow(
            asset.name.includes('-duplicate-name')
              ? chalk.red.bold(asset.name)
              : chalk.green(asset.name),
            formatSize(asset.size)
          )
        )
        .join(`\n`)
  );
  return ui.toString();
}
function removeFromName(name) {
  // Usar una expresión regular para extraer solo el nombre final después de `=`
  const cleanName = name.includes('=') ? name.split('=').pop() : name;
  return cleanName.trim(); // Eliminar cualquier espacio en blanco adicional
}
function exportIcons() {
  getFigmaFile().then((res) => {
    getImages(res)
      .then((icons) => {
        console.log(`Api returned ${icons.length} icons\n`);
        createOutputDirectory().then(() => {
          deleteIcons().then(() => {
            spinner.start('Downloading');
            const AllIcons = icons.map((icon) =>
              downloadImage(
                icon.image,
                removeFromName(icon.name),
                icon.category
              )
            );
            // const AllIcons = []
            Promise.all(AllIcons).then((res) => {
              spinner.succeed(chalk.cyan.bold('Download Finished!\n'));
              console.log(`${makeResultsTable(res)}\n`);
            });
          });
        });
      })
      .catch((err) => {
        console.log(chalk.red(err));
      });
  });
}

function run() {
  updateGitIgnore();
  if (argv.c) {
    deleteConfig();
  }
  getConfig().then(() => {
    figmaClient = figma(config.figmaPersonalToken);
    exportIcons();
  });
}

run();
