const CONFIG = require('../config.json');
const fs = require('fs');
const projects = require('../website/projects');
const yaml = require('js-yaml');

/*
 * Generates 21_features_update_tmp.sh
 * in order to update minutely/hourly OSM features
 */

// Constants
const OSM_PBF_LATEST = CONFIG.WORK_DIR + '/' + CONFIG.OSH_PBF_URL.split("/").pop().replace(".osh.pbf", ".osm.pbf");
const OSM_PBF_LATEST_UNSTABLE = OSM_PBF_LATEST.replace(".osm.pbf", ".new.osm.pbf");
const OSM_PBF_LATEST_UNSTABLE_FILTERED = OSM_PBF_LATEST.replace(".osm.pbf", ".new-local.osm.pbf");
const OSM_POLY = OSM_PBF_LATEST.replace("-internal.osm.pbf", ".poly");
const IMPOSM_YML = CONFIG.WORK_DIR + '/imposm.yml';
const IMPOSM_CACHE_DIR = CONFIG.WORK_DIR + '/imposm_cache';
const IMPOSM_DIFF_DIR = CONFIG.WORK_DIR + '/imposm_diffs';
const OSC_FULL = CONFIG.WORK_DIR + '/changes_features.osc.gz';
const OSC_LOCAL = CONFIG.WORK_DIR + '/changes_features.local.osc.gz';
const PSQL_DB = `postgres://${CONFIG.DB_USER}:${CONFIG.DB_PASS}@${CONFIG.DB_HOST}:${CONFIG.DB_PORT}/${CONFIG.DB_NAME}`;
const OUTPUT_SCRIPT = __dirname+'/21_features_update_tmp.sh';


// Generate Imposm YAML config file
const yamlData = {
	tables: {},
	tags: { load_all: true }
};
const preSQL = [];
const postSQL = [];
const postUpdateSQL = [];

Object.entries(projects).forEach(e => {
	const [ id, project ] = e;
	const tableData = {
		mapping: project.database.imposm.mapping,
		columns: [
			{ name: 'osm_id', type: 'id' },
			{ name: 'name', key: 'name', type: 'string' },
			{ name: 'tags', type: 'hstore_tags' },
			{ name: 'geom', type: 'geometry' }
		]
	};

	project.database.imposm.types.forEach(type => {
		yamlData.tables[`${id.split("_").pop()}_${type}`] = Object.assign({ type }, tableData);
	});

	preSQL.push(`DROP VIEW IF EXISTS project_${id.split("_").pop()} CASCADE`);
	postSQL.push(
		`CREATE OR REPLACE VIEW project_${id.split("_").pop()} AS `
		+ project.database.imposm.types.map(type => {
			const osmid = type === "point" ? "CONCAT('node/', osm_id) AS osm_id" : "CASE WHEN osm_id < 0 THEN CONCAT('relation/', -osm_id) ELSE CONCAT('way/', osm_id) END AS osm_id";
			const geom = type === "point" ? "geom::GEOMETRY(Point, 3857)" : "ST_PointOnSurface(geom)::GEOMETRY(Point, 3857) AS geom";
			return `SELECT ${osmid}, name, hstore_to_json(tags) AS tags, tags ?| ARRAY['note','fixme'] AS needs_check, ${geom} FROM project_${id.split("_").pop()}_${type}`
		}).join(" UNION ALL ")
	);

	// Comparison tables
	if(project.database.compare) {
		// Table definition
		project.database.compare.types.forEach(type => {
			yamlData.tables[`${id.split("_").pop()}_compare_${type}`] = Object.assign({ type }, tableData, { mapping: project.database.compare.mapping });
		});

		preSQL.push(`DROP VIEW IF EXISTS project_${id.split("_").pop()}_compare CASCADE`);
		postSQL.push(
			`CREATE OR REPLACE VIEW project_${id.split("_").pop()}_compare AS `
			+ project.database.compare.types.map(type => {
				const osmid = type === "point" ? "CONCAT('node/', osm_id) AS osm_id" : "CASE WHEN osm_id < 0 THEN CONCAT('relation/', -osm_id) ELSE CONCAT('way/', osm_id) END AS osm_id";
				const geom = type === "point" ? "geom::GEOMETRY(Point, 3857)" : "ST_Centroid(geom)::GEOMETRY(Point, 3857) AS geom";
				return `SELECT ${osmid}, name, hstore_to_json(tags) AS tags, ${geom} FROM project_${id.split("_").pop()}_compare_${type}`
			}).join(" UNION ALL ")
		);

		preSQL.push(`DROP MATERIALIZED VIEW IF EXISTS project_${id.split("_").pop()}_compare_tiles`);
		postSQL.push(
			`CREATE MATERIALIZED VIEW IF NOT EXISTS project_${id.split("_").pop()}_compare_tiles AS SELECT * FROM project_${id.split("_").pop()}_compare WHERE osm_id NOT IN (SELECT DISTINCT c.osm_id FROM project_${id.split("_").pop()}_compare c, project_${id.split("_").pop()} b WHERE ST_DWithin(c.geom, b.geom, ${project.database.compare.radius}))`
		);
		postSQL.push(`CREATE INDEX project_${id.split("_").pop()}_compare_tiles_geom_idx ON project_${id.split("_").pop()}_compare_tiles USING GIST(geom)`);
		postUpdateSQL.push(`REFRESH MATERIALIZED VIEW project_${id.split("_").pop()}_compare_tiles`);
	}
});

fs.writeFile(IMPOSM_YML, yaml.safeDump(yamlData), err => {
	if(err) {
		throw new Error(err);
	}
});

// View for multi-type layers
const sqlToFull = sqlin => sqlin.map(vs => (`psql "${PSQL_DB}" -c "${vs}"`)).join("\n\t");
const preSQLFull = preSQL.length > 0 ? sqlToFull(preSQL) : "";
const postSQLFull = postSQL.length > 0 ? sqlToFull(postSQL) : "";
const postUpdateSQLFull = postUpdateSQL.length > 0 ? sqlToFull(postUpdateSQL) : "";


// Script text
const separator = `echo "-------------------------------------------------------------------"
echo ""`;

const script = `#!/bin/bash

# Script for updating OSM features for each project
# Generated automatically by npm run features:update

set -e

mode="$1"
if [ "$mode" == "" ]; then
	mode="update"
fi

echo "==== Get latest changes"
osmupdate --keep-tempfiles --trust-tempfiles \\
	-t="${CONFIG.WORK_DIR}/osmupdate/" \\
	-v "${OSM_PBF_LATEST}" \\
	"${OSC_FULL}"
osmium apply-changes "${OSM_PBF_LATEST}" \\
	"${OSC_FULL}" \\
	-O -o "${OSM_PBF_LATEST_UNSTABLE}"
osmium extract -p "${OSM_POLY}" -s simple "${OSM_PBF_LATEST_UNSTABLE}" -O -o "${OSM_PBF_LATEST_UNSTABLE_FILTERED}"
rm -f "${OSM_PBF_LATEST_UNSTABLE}" "${OSC_FULL}"
${separator}

if [ "$mode" == "init" ]; then
	echo "==== Initial import with Imposm"
	rm -f "${OSM_PBF_LATEST}" "${OSC_LOCAL}"
	mv "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" "${OSM_PBF_LATEST}"
	mkdir -p "${IMPOSM_CACHE_DIR}"
	imposm import -mapping "${IMPOSM_YML}" \\
		-read "${OSM_PBF_LATEST}" \\
		-overwritecache -cachedir "${IMPOSM_CACHE_DIR}" \\
		-diff -diffdir "${IMPOSM_DIFF_DIR}"

	${preSQLFull}

	imposm import -write \\
		-connection "${PSQL_DB}?prefix=project_" \\
		-mapping "${IMPOSM_YML}" \\
		-cachedir "${IMPOSM_CACHE_DIR}" \\
		-dbschema-import public -diff

	${postSQLFull}
else
	echo "==== Apply latest changes to database"
	osmium derive-changes "${OSM_PBF_LATEST}" "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" -o "${OSC_LOCAL}"
	imposm diff -mapping "${IMPOSM_YML}" \\
		-cachedir "${IMPOSM_CACHE_DIR}" \\
		-dbschema-production public \\
		-connection "${PSQL_DB}?prefix=project_" \\
		"${OSC_LOCAL}"

	${postUpdateSQLFull}
	rm -f "${OSM_PBF_LATEST}" "${OSC_LOCAL}"
	mv "${OSM_PBF_LATEST_UNSTABLE_FILTERED}" "${OSM_PBF_LATEST}"
fi
${separator}

echo "Done"
`;

fs.writeFile(OUTPUT_SCRIPT, script, { mode: 0o766 }, err => {
	if(err) { throw new Error(err); }
	console.log("Done");
});
