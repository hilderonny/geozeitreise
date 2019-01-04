const coordinates = require('../server/coordinates');
const fs = require('fs');
const byline = require('byline');
const jpegjs = require('jpeg-js');
const pngjs = require('pngjs');
const pureimage = require('pureimage');
const request = require('request');
const sharp = require('sharp');
const unzip = require('unzip');

const dgmPath = __dirname + '/../server/data/dgm/';
console.log(dgmPath);

function getJson(url) {
    return new Promise(function(resolve, reject) {
        request(url, function(error, response, body) {
            const json = JSON.parse(body);
            resolve(json);
        });
    });
}

function downloadAndExtract(url, destination) {
    return new Promise(function(resolve, reject) {
        const heightArray = [];//new Int32Array(1000 * 1000 * 4);
        //const bitmap = pureimage.make(1000, 1000);
        /**
         * Am sinnvollsten ist es immernoch, die Daten als 24-Bit PNG-Datei zu speichern.
         * Damit ist so ein Bereich von 1kmx1km etwa 1 MB groß. Wenn man als JPEG speichert,
         * muss man mit 100% Qualität speichern, was die Datei auf 1,7 MB aufbläht. Andernfalls
         * hätte man Genauigkeitsverluste.
         * 
         * TODO: Die Chunks sind zu groß. Sowohl die Datei von 1 MB als auch die PlaneGeometry
         * später in der Anzeige von 1000 * 1000 sind nicht performant handhabbar.
         */
        const png = new pngjs.PNG({ width: 1000, height: 1000, colorType: 2 });
        const jpegBuffer = new Buffer(1000 * 1000 * 4);
        request(url).pipe(unzip.Parse()).on('entry', function(entry) {
            const fileName = entry.path;
            if (!fileName.endsWith('.xyz')) return entry.autodrain;
            console.log('Verarbeite: ' + fileName);
            const lineStream = byline.createStream();
            let pixelIndex = 0;
            lineStream.on('data', function(line) {
                const lineString = line.toString();
                if (!lineString) return;
                const lineParts = lineString.split(' ');
                if (lineParts.length < 3) return;
                const height = parseInt(lineParts[2].replace('.', ''));
                heightArray.push(height);
                const r = height & 0xff, g = (height >> 8) & 0xff, b = (height >> 16) & 0xff, a = 0xff;
                png.data[pixelIndex] = r;
                png.data[pixelIndex + 1] = g;
                png.data[pixelIndex + 2] = b
                png.data[pixelIndex + 3] = a;
                jpegBuffer[pixelIndex] = r;
                jpegBuffer[pixelIndex + 1] = g;
                jpegBuffer[pixelIndex + 2] = b
                jpegBuffer[pixelIndex + 3] = a;
                
                /**
                 * Die Zeilen sehen so aus:
                 * 644001.00 5650999.00 190.24
                 * Dabei sind zuerst die eastings in der ersten Spalte aufsteigend sortiert.
                 * Danach die northings in der zweiten Spalte ABSTEIGEND.
                 * Die letzte Spalte stellt den Höhenert dar. Also:
                 * 644000.00 5650999.00 190.24
                 * 644001.00 5650999.00 190.24
                 * ...
                 * 644999.00 5650999.00 190.24
                 * 644000.00 5650998.00 190.24
                 * 644001.00 5650998.00 190.24
                 * ...
                 * 644999.00 5650001.00 190.24
                 * 644000.00 5650000.00 190.24
                 * 644001.00 5650000.00 190.24
                 * ...
                 * 644999.00 5650000.00 190.24
                 * Jede Datei hat also stets 1.000 * 1.000 = 1.000.000 Einträge
                 */
                pixelIndex += 4;
            });
            entry.pipe(lineStream);
        }).on('close', function() {
            const buffer = new Buffer(heightArray);
            console.log(buffer.byteLength);
            // Hier haben wir die Rohdaten und speichern diese erst mal ab
            const binFileName = destination + 'height.dat';
            console.log('Speichere Datei: ' + binFileName);
            fs.writeFileSync(binFileName, buffer);
            const pngFileName = destination + 'height.png';
            console.log('Speichere PNG: ' + pngFileName);
            png.pack().pipe(fs.createWriteStream(pngFileName)).on('close', function() {
                resolve(destination);
                const jpgFileName = destination + 'height.jpg';
                console.log('Speichere JPG: ' + jpgFileName);
                fs.writeFileSync(jpgFileName, jpegjs.encode({ data: jpegBuffer, width: 1000, height: 1000 }, 95).data);
                resolve(destination);
            });
            /*
            pureimage.encodePNGToStream(bitmap, fs.createWriteStream(pngFileName)).then(function() {
                const jpgFileName = destination + 'height.jpg';
                console.log('Speichere JPG: ' + jpgFileName);
                return pureimage.encodeJPEGToStream(bitmap, fs.createWriteStream(jpgFileName));
            }).then(function() {
                resolve(destination);
            });
            // Jetzt noch die Daten als PNG speichern
            // Dafür gibt es die Bibliotheken "sharp" (Mit nativen Abhängigkeiten) und "pureimage"
            /*
            const image = sharp(buffer, {
                raw: { width: 1000, height: 1000, channels: 3 }
            });
            image.png().toFile(destination + 'heights.png');
            image.jpeg({ quality: 100 }).toFile(destination + 'heights.jpg');
            */
        });
    });
}

/**
 * Lädt Höhendaten vom Geoportal und generiert binäre
 * Profildateien, die im Client als Heightmaps interpretiert werden können.
 * 
 * Das das Geoportal Thüringen eben nur Daten von Thüringen bereit stellt, verwende ich als Datenquelle
 * http://data.opendataportal.at/dataset/dtm-germany bzw. https://drive.google.com/drive/folders/0BxphPoRgwhnoWkRoTFhMbTM3RDA,
 * wo die Höhendaten von ganz Europa zu finden sind. Dort ist die Auflösung aber nur 20m-30m.
 */

 (async function() {

    // Koordinaten festlegen, wie sie aus GPS Receivers kämen
    const latitude = 50.9904901;
    const longitude = 11.0528969;
    console.log('Latitude: ' + latitude + ', Longitude: ' + longitude);

    // Koordinaten ins UTM-Format umwandeln
    const utmCoordinates = coordinates.fromLatLon(latitude, longitude);
    const areaKey = { 
        easting: Math.floor(utmCoordinates.easting / 1000),
        northing: Math.floor(utmCoordinates.northing / 1000)
    };
    console.log(utmCoordinates.zoneLetter + utmCoordinates.zoneNum + ': ' + utmCoordinates.easting + ' Ost, ' + utmCoordinates.northing + ' Nord, Schlüssel: ' + areaKey.easting + '/' + areaKey.northing);

    // Prüfen, ob bereits DGM-Daten herunter geladen wurden
    const eastingPath = dgmPath + areaKey.easting + '/';
    const northingPath = eastingPath + areaKey.northing + '/';
    if (!fs.existsSync(eastingPath)) fs.mkdirSync(eastingPath);
    if (!fs.existsSync(northingPath)) fs.mkdirSync(northingPath);
    // Übersicht laden, wo die einzelnen Kacheln vermerkt sind
    // https://geoportal.geoportal-th.de/gaialight-th/_apps/dladownload/_ajax/overview.php?bbox%5B%5D=644074&bbox%5B%5D=5650773&bbox%5B%5D=644075&bbox%5B%5D=5650774&crs=EPSG%3A25832&type%5B%5D=dhm1
    const overviewUrl = 'https://geoportal.geoportal-th.de/gaialight-th/_apps/dladownload/_ajax/overview.php?bbox%5B%5D=' + Math.floor(utmCoordinates.easting) + '&bbox%5B%5D=' + Math.floor(utmCoordinates.northing) + '&bbox%5B%5D=' + Math.ceil(utmCoordinates.easting) + '&bbox%5B%5D=' + Math.ceil(utmCoordinates.northing) + '&crs=EPSG%3A25832&type%5B%5D=dhm1';
    const overview = await getJson(overviewUrl);
    console.log('Anzahl Kacheln: ' + overview.result.features.length);

    overview.result.features.forEach(async function(feature) {
        const bounding = {
            east: feature.geometry.coordinates[0][0][0][0],
            north: feature.geometry.coordinates[0][0][1][1],
            south: feature.geometry.coordinates[0][0][0][1],
            west: feature.geometry.coordinates[0][0][2][0],
        };
        const detailsUrl = 'https://geoportal.geoportal-th.de/gaialight-th/_apps/dladownload/_ajax/details.php?type=dhm1&id=' + feature.properties.gid;
        const details = await getJson(detailsUrl);
        const dgmUrl = 'https://geoportal.geoportal-th.de' + details.object.file1;
        console.log('Lade herunter: ' + dgmUrl);
        await downloadAndExtract(dgmUrl, northingPath);
    });

})();