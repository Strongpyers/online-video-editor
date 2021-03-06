/**
 * @file Controller for REST API
 * @author Ervis Semanaj
 */

import config from '../config';
import mltxmlManager from '../models/mltxmlManager';
import fileManager from '../models/fileManager';
import timeManager from '../models/timeManager';
import rendererManager from '../models/rendererManager';
import log from '../models/logger';

const fs = require('fs');
const path = require('path');
const generate = require('nanoid/generate');
const { exec } = require('child_process');

exports.default = (req, res) => {
	res.json({
		msg: 'For API documentation see https://github.com/',
	});
};


exports.projectPOST = (req, res, next) => {
    const renderer = {
		projectID: generate('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890', 32),
		projectName: '',
		resources: {},
		timeline: [
			{
				id: 'audiotrack0',
				items: []
			},
			{
				id: 'videotrack0',
				items: []
			}
		]
	};

	fs.mkdir(path.join(config.projectPath, renderer.projectID), { recursive: true }, (err) => {
		if (err) return next(err);
    });

	rendererManager.saveRenderer(renderer.projectID, renderer).then(
		() => {
			res.json({
				project: renderer.projectID,
			});
		},
		err => next(err)
	);
};


exports.projectGET = (req, res) => {
	rendererManager.loadRenderer(req.params.projectID).then(
		(renderer) => {
			res.json({
				project: req.params.projectID,
				projectName: renderer.projectName,
				resources: renderer.resources,
				timeline: renderer.timeline,
			});
		},
		err => fileErr(err, res)
	);
};


exports.projectFilePOST = (req, res, next) => {

	if (!isset(req.busboy)) {
		res.status(400);
		res.json({
			err: 'File is missing.',
			msg: 'The request body must contain a file to upload.',
		});
		return;
	}

	req.busboy.on('file', (fieldname, file, filename, transferEncoding, mimeType) => {

		const fileID = generate('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890', 16);
		const extension = path.extname(filename);
		let filepath = path.join(config.projectPath, req.params.projectID, fileID);
		if (extension.length > 1) filepath += extension;

		// Create a write stream of the new file
		const fstream = fs.createWriteStream(filepath);

		log.info(`Upload of "${filename}" started`);

		// Pipe it trough
		file.pipe(fstream);

		// On finish of the upload
		fstream.on('close', () => {
			log.info(`Upload of "${filename}" finished`);

			fileManager.getDuration(filepath, mimeType).then(
				length => {
					if (length !== null) length += '0';
					rendererManager.loadRenderer(req.params.projectID).then(
						(renderer) => {
							renderer.resources[fileID] = {
								id: fileID,
								filepath: path.resolve(filepath),
								mimeType,
								name: filename,
								length
							};

							rendererManager.saveRenderer(req.params.projectID, renderer).then(
								() => {
									res.json({
										msg: `Upload of "${filename}" OK`,
										resource_id: fileID,
										resource_mime: mimeType,
										length: length,
									});
								},
								err => next(err)
							);
						},
						err => fileErr(err, res)
					);
				}
			);
		});
	});

	req.pipe(req.busboy); // Pipe it trough busboy
};


exports.projectFileDELETE = (req, res, next) => {
	rendererManager.loadRenderer(req.params.projectID).then(
		(renderer) => {
			const track = renderer.timeline.find(track => track.items.find(item => item.id === req.params.fildID));
			if (track) {
				res.status(403);
				res.json({
					err: 'Source in use.',
					msg: 'The resource is being used in the project. Remove it from the timeline before deleting it from the project.',
				});
				return;
			}

			const resource = renderer.resources[req.params.fileID];
			if (!resource) {
				res.status(404);
				res.json({
					err: 'Source not found.',
					msg: 'The resource is not in the project.'
				});
				return;
			}

			const filepath = resource.filepath;
			if (filepath === null) {
				return next(`Project "${req.params.projectID}", resource ${req.params.fileID} misses filepath`);
			}

			// Try to remove file, log failure
			fs.unlink(filepath, (err) => {
				if (err) log.error(err);
			});
			
			delete renderer.resources[req.params.fileID];

			rendererManager.saveRenderer(req.params.projectID, renderer).then(
				() => {
					res.json({
						msg: 'Feed removed successfully',
					});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);
};


exports.projectFilePUT = (req, res, next) => {

	// Required parameters: track
	if (!isset(req.body.track)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required track parameter',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const producer = document.getElementById(`producer${req.params.fileID}`);
			if (producer === null) {
				release();
				res.status(404);
				res.json({
					err: 'Source not found.',
					msg: 'The resource is not in the project.',
				});
				return;
			}

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			const newEntry = document.createElement('entry');
			newEntry.setAttribute('producer', 'producer' + req.params.fileID);

			const mime = mltxmlManager.getProperty(producer.getElementsByTagName('property'), 'musecut:mime_type');
			if (mime === null) {
				release();
				return next(`Project "${req.params.projectID}", producer "${req.params.fileID}" missing mime_type tag`);
			}
			else if (new RegExp(/^image\//).test(mime)) {
				if (new RegExp(/^videotrack\d+/).test(req.body.track) === false) {
					release();
					res.status(400);
					res.json({
						err: 'Unsupported file type.',
						msg: 'Images can only be embedded on a video track.',
					});
					return;
				}

				// Images needs duration parameter
				if (!timeManager.isValidDuration(req.body.duration)) {
					release();
					res.status(400);
					res.json({
						err: 'Missing duration.',
						msg: 'To insert an image on the timeline, you must specify a duration of 00: 00: 00,000.',
					});
					return;
				}

				newEntry.setAttribute('in', '00:00:00,000');
				newEntry.setAttribute('out', req.body.duration);
			}
			else if (new RegExp(/^video\//).test(mime)) {
				if (new RegExp(/^videotrack\d+/).test(req.body.track) === false) {
					release();
					res.status(400);
					res.json({
						err: 'Unsupported file type.',
						msg: 'You can only embed a video on a video track.',
					});
					return;
				}
			}
			else if (new RegExp(/^audio\//).test(mime)) {
				if (new RegExp(/^audiotrack\d+/).test(req.body.track) === false) {
					release();
					res.status(400);
					res.json({
						err: 'Unsupported file type.',
						msg: 'Audio can only be inserted on an audio track.',
					});
					return;
				}
			}
			else {
				// Reject everything except images, videos and audio
				release();
				res.status(403);
				res.json({
					err: 'Unsupported file type.',
					msg: 'Only video, image, or audio can be inserted on the timeline.',
				});
				return;
			}

			track.appendChild(newEntry);

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({
						msg: 'Item added to timeline',
						timeline: req.body.track,
					});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);

};

exports.projectFilterPOST = (req, res, next) => {

	// Required parameters: track, item, filter
	if (!isset(req.body.track, req.body.item, req.body.filter)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: "track", "item", "filter".',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			const item = mltxmlManager.getItem(document, track, req.body.item);
			if (item === null) {
				release();
				res.status(404);
				res.json({
					err: 'Item not found.',
					msg: `Položka "${req.body.item}" se na stopě "${req.body.track}" nenachází.`,
				});
				return;
			}

			let trackIndex;
			let newTractor;

			if (mltxmlManager.isSimpleNode(item)) {
				// Create playlist after last producer
				const newPlaylist = mltxmlManager.entryToPlaylist(item, document);

				// Create tractor before videotrack0
				newTractor = mltxmlManager.createTractor(document);
				newTractor.innerHTML = `<multitrack><track producer="${newPlaylist.id}"/></multitrack>`;

				trackIndex = 0;

				// Update track playlist
				item.removeAttribute('in');
				item.removeAttribute('out');
				item.setAttribute('producer', newTractor.id);
			}
			else {
				trackIndex = mltxmlManager.getTrackIndex(item);

				// Check if filter is already applied
				const filters = item.parentElement.parentElement.getElementsByTagName('filter');
				for (let filter of filters) {
					let filterName;
					if (filter.getAttribute('musecut:filter') !== null) filterName = filter.getAttribute('musecut:filter');
					else filterName = filter.getAttribute('mlt_service');
					if (filterName === req.body.filter && filter.getAttribute('track') === trackIndex.toString()) {
						release();
						res.status(403);
						res.json({
							err: 'Filtr je již aplikován.',
							msg: `Položka "${req.body.item}" na stopě "${req.body.track}" má již filtr "${req.body.filter}" aplikován.`,
						});
						return;
					}
				}

				newTractor = item.parentElement.parentElement;
			}

			// Add new filter
			const newFilter = document.createElement('filter');
			let filterName = req.body.filter;
			if (isset(config.mapFilterNames[req.body.filter])) {
				filterName = config.mapFilterNames[req.body.filter];
				const newPropery = document.createElement('property');
				newPropery.setAttribute('name', 'musecut:filter');
				newPropery.innerHTML = req.body.filter;
				newFilter.appendChild(newPropery);
			}
			newFilter.setAttribute('mlt_service', filterName);
			newFilter.setAttribute('track', trackIndex.toString());
			newTractor.appendChild(newFilter);

			if (isset(req.body.params)) {
				for (let param in req.body.params) {
					const newPropery = document.createElement('property');
					newPropery.setAttribute('name', param);
					if (typeof req.body.params[param]  === 'number') {
						const value = req.body.params[param].toString();
						newPropery.innerHTML = value.replace(/\./, ',');
					}
					else {
						newPropery.innerHTML = req.body.params[param];
					}
					newFilter.appendChild(newPropery);
				}
			}

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({msg: 'Filtr přidán'});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);

};


exports.projectFilterDELETE = (req, res, next) => {

	// Required parameters: track, item, filter
	if (!isset(req.body.track, req.body.item, req.body.filter)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: "track", "item", "filter".',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			const item = mltxmlManager.getItem(document, track, req.body.item);
			if (item === null) {
				release();
				res.status(404);
				res.json({
					err: 'Item not found.',
					msg: `Položka "${req.body.item}" se na stopě "${req.body.track}" nenachází.`,
				});
				return;
			}

			let filterName = req.body.filter;
			if (isset(config.mapFilterNames[req.body.filter])) {
				filterName = config.mapFilterNames[req.body.filter];
			}

			const tractor = item.parentElement.parentElement;
			const trackIndex = mltxmlManager.getTrackIndex(item);
			const filters = tractor.getElementsByTagName('filter');
			let filter;
			for (let entry of filters) {
				if (entry.getAttribute('mlt_service') === filterName && entry.getAttribute('track') === trackIndex.toString()) {
					if (filterName === req.body.filter) {
						filter = entry;
						break;
					}
					// filterName is alias
					const alias = mltxmlManager.getProperty(entry.getElementsByTagName('property'), 'musecut:filter');
					if (alias === req.body.filter) {
						filter = entry;
						break;
					}
				}
			}

			// Check if filter exists
			if (mltxmlManager.isSimpleNode(item) || filter === undefined) {
				release();
				res.status(404);
				res.json({
					err: 'Filtr nenalezen.',
					msg: `Filtr "${req.body.filter}" se na ${req.body.item}. položce stopy "${req.body.track}" nenachází.`,
				});
				return;
			}

			filter.remove();

			// Tractor without filters, with one track
			if (!mltxmlManager.isUsedInTractor(item) && tractor.getElementsByTagName('multitrack').item(0).childElementCount === 1) {
				const playlist = document.getElementById(item.getAttribute('producer'));
				const entry = playlist.getElementsByTagName('entry').item(0);
				const tractorUsage = document.querySelector(`mlt>playlist>entry[producer="${tractor.id}"]`);
				tractorUsage.parentElement.insertBefore(entry, tractorUsage);

				tractorUsage.remove();
				tractor.remove();
				playlist.remove();
			}

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({msg: 'Filtr odebrán'});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);

};


exports.projectTransitionPOST = (req, res, next) => {

	// Required parameters: track, itemA, itemB, transition, duration
	if (!isset(req.body.track, req.body.itemA, req.body.itemB, req.body.transition, req.body.duration)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: track, itemA, itemB, transition, duration.',
		});
		return;
	}

	if (!isNaturalNumber(req.body.itemA, req.body.itemA) || !timeManager.isValidDuration(req.body.duration)) {
		res.status(400);
		res.json({
			err: 'Incorrect parameters.',
			msg: 'ItemA, itemB must be integer, nonnegative, duration must be nonzero, in the format 00: 00: 00,000.',
		});
		return;
	}

	if ((req.body.itemB - req.body.itemA) !== 1) {
		res.status(400);
		res.json({
			err: 'Incorrect parameters.',
			msg: 'itemA must directly follow itemB.',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			const itemA = mltxmlManager.getItem(document, track, req.body.itemA);
			const itemB = mltxmlManager.getItem(document, track, req.body.itemB);

			if (itemA === null || itemB === null) {
				release();
				res.status(404);
				res.json({
					err: 'Item not found.',
					msg: `${req.body.itemA} or ${req.body.itemA} is not on track "${req.body.track}".`,
				});
				return;
			}

			const durationA = mltxmlManager.getDuration(itemA, document);
			const durationB = mltxmlManager.getDuration(itemB, document);
			const waitBeforeTransition = timeManager.subDuration(durationA.out, req. body.duration);
			if (req.body.duration > durationA.time || req.body.duration > durationB.time) {
				release();
				res.status(400);
				res.json({
					err: 'Transition time too long.',
					msg: 'The transition is longer than one of the transition items.',
				});
				return;
			}

			// Simple + Simple
			if (mltxmlManager.isSimpleNode(itemA) && mltxmlManager.isSimpleNode(itemB)) {
				// Create playlist after last producer
				const newPlaylistA = mltxmlManager.entryToPlaylist(itemA, document);
				const newPlaylistB = mltxmlManager.entryToPlaylist(itemB, document);
				newPlaylistB.innerHTML = `<blank length="${waitBeforeTransition}" />` + newPlaylistB.innerHTML;

				// Create tractor before videotrack0
				const newTractor = mltxmlManager.createTractor(document);
				newTractor.innerHTML = `<multitrack><track producer="${newPlaylistA.id}"/><track producer="${newPlaylistB.id}"/></multitrack>`;
				newTractor.innerHTML += `<transition mlt_service="${req.body.transition}" in="${waitBeforeTransition}" out="${durationA.out}" a_track="0" b_track="1"/>`;

				// Update track
				itemA.removeAttribute('in');
				itemA.removeAttribute('out');
				itemA.setAttribute('producer', newTractor.id);
				itemB.remove();
			}
			// Complex + Simple
			else if (!mltxmlManager.isSimpleNode(itemA) && mltxmlManager.isSimpleNode(itemB)) {
				const newPlaylist = mltxmlManager.entryToPlaylist(itemB, document);
				mltxmlManager.appendPlaylistToMultitrack(itemA.parentElement, newPlaylist, req.body.duration, req.body.transition, document);
				itemB.remove();
			}
			// Complex + Complex
			else if (!mltxmlManager.isSimpleNode(itemA)) {
				const multitrackA = itemA.parentElement;
				const multitrackB = itemB.parentElement;
				if (multitrackA === multitrackB) {
					release();
					res.status(403);
					res.json({
						err: 'Gradient already applied.',
						msg: 'The selected elements already have a mutual transition.',
					});
					return;
				}

				let duration = req.body.duration;
				let transition = req.body.transition;
				let newTrackIndex = multitrackB.childElementCount;
				let oldTrackIndex = 0;
				const transitions = multitrackB.parentElement.getElementsByTagName('transition');
				const filters = multitrackB.parentElement.getElementsByTagName('filter');
				const tracksB = multitrackB.childNodes;
				for (let
					track of tracksB) {
					// Merge transition
					if (!isset(transition)) {
						for (let transitionElement of transitions) {
							if (transitionElement.getAttribute('b_track') === oldTrackIndex.toString()) {
								transition = transitionElement.getAttribute('mlt_service');
								duration = timeManager.subDuration(transitionElement.getAttribute('out'), transitionElement.getAttribute('in'));
							}
						}
					}

					// Merge filters
					for (let filter of filters) {
						if (filter.getAttribute('track') === oldTrackIndex.toString()) {
							filter.setAttribute('track', newTrackIndex.toString());
							multitrackA.parentElement.append(filter);
						}
					}

					let playlist = document.getElementById(track.getAttribute('producer'));
					mltxmlManager.appendPlaylistToMultitrack(multitrackA, playlist, duration, transition, document);

					transition = undefined;
					duration = undefined;
					newTrackIndex++;
					oldTrackIndex++;
				}
				const tractorB = multitrackB.parentElement;
				const tractorBentry = document.querySelector(`mlt>playlist>entry[producer="${tractorB.id}"]`);
				tractorBentry.remove();
				tractorB.remove();
			}
			// Simple + Complex
			else {
				const durationA = timeManager.subDuration(mltxmlManager.getDuration(itemA, document).time, req.body.duration);
				const multitrackB = itemB.parentElement;
				// Re-index transition, adjust IN/OUT timing
				const transitions = multitrackB.parentElement.getElementsByTagName('transition');
				for (let transition of transitions) {
					transition.setAttribute('a_track', Number(transition.getAttribute('a_track')) + 1);
					transition.setAttribute('b_track', Number(transition.getAttribute('b_track')) + 1);
					transition.setAttribute('in', timeManager.addDuration(transition.getAttribute('in'), durationA));
					transition.setAttribute('out', timeManager.addDuration(transition.getAttribute('out'), durationA));
				}
				// Re-index filters
				const filters = multitrackB.parentElement.getElementsByTagName('filter');
				for (let filter of filters) {
					filter.setAttribute('track', Number(filter.getAttribute('track')) + 1);
				}
				// Adjust blank duration of tracks
				const tracks = multitrackB.childNodes;
				for (let track of tracks) {
					let playlist = document.getElementById(track.getAttribute('producer'));
					let blank = playlist.getElementsByTagName('blank').item(0);
					if (blank === null)
						playlist.innerHTML = `<blank length="${durationA}" />` + playlist.innerHTML;
					else
						blank.setAttribute('length', timeManager.addDuration(blank.getAttribute('length'), durationA));
				}
				// Prepend multitrack with item
				const newPlaylist = mltxmlManager.entryToPlaylist(itemA, document);
				multitrackB.innerHTML = `<track producer="${newPlaylist.id}" />` + multitrackB.innerHTML;
				// Add new transition
				multitrackB.parentElement.innerHTML += `<transition mlt_service="${req.body.transition}" in="${durationA}" out="${mltxmlManager.getDuration(itemA, document).time}" a_track="0" b_track="1" />`;

				itemA.remove();
			}

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({msg: 'Transition applied'});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);

};


exports.projectPUT = (req, res, next) => {

	const projectPath = mltxmlManager.getWorkerDir(req.params.projectID);

	fs.open(path.join(projectPath, 'processing'), 'wx', (err, file) => {
		if (err) {
			switch (err.code) {
				case 'EEXIST':
					res.status(403);
					res.json({
						err: 'Processing in progress.',
						msg: 'The project is already being processed, please wait for it to finish.',
					});
					return;
				case 'ENOENT':
					fileErr(err, res);
					return;
				default:
					return next(err);
			}
		}
		fs.close(file, (err) => {
			if (err) log.error(err.stack);
		});

		exec(`cd ${projectPath} && melt project.mlt -consumer avformat:output.mp4 acodec=aac vcodec=libx264 > stdout.log 2> stderr.log`, (err) => {
			if (err) log.error(`exec error: ${err}`);

			fs.unlink(path.join(projectPath, 'processing'), (err) => {
				if (err) log.error(err.stack);
			});

			if (isset(req.body.email)) {
				emailManager.sendProjectFinished(req.body.email, req.params.projectID, !(err));
			}
		});
		res.json({
			msg: 'Processing started'
		});
	});

};


exports.projectItemDELETE = (req, res, next) => {

	// Required parameters: track, item
	if (!isset(req.body.track, req.body.item)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: track, item.',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			let item = mltxmlManager.getItem(document, track, req.body.item);
			if (item === null) {
				release();
				res.status(404);
				res.json({
					err: 'Item not found.',
					msg: `${req.body.item} is not on track "${req.body.track}".`,
				});
				return;
			}

			let entry;
			let duration = mltxmlManager.getDuration(item, document).time;

			if (mltxmlManager.isSimpleNode(item)) { // It's simple element
				entry = item;
			}
			else {
				const tractor = item.parentElement.parentElement;
				if (tractor.getElementsByTagName('transition').length === 0) { // It's element with filter(s)
					const playlist = document.querySelector(`mlt>playlist[id="${item.getAttribute('producer')}"]`);
					entry = document.querySelector(`mlt>playlist>entry[producer="${tractor.id}"]`);

					tractor.remove();
					playlist.remove();
				}
				else { // It's element with transition(s)
					release();
					return;
				}
			}

			const prevEntry = entry.previousElementSibling;
			const nextEntry = entry.nextElementSibling;
			if (nextEntry !== null) {
				// Replace with blank
				if (prevEntry !== null && prevEntry.tagName === 'blank') {
					duration = timeManager.addDuration(duration, prevEntry.getAttribute('length'));
					prevEntry.remove();
				}
				if (nextEntry.tagName === 'blank') {
					duration = timeManager.addDuration(duration, nextEntry.getAttribute('length'));
					nextEntry.remove();
				}
				entry.outerHTML = `<blank length="${duration}"/>`;
			}
			else {
				// Last item, just delete
				if (prevEntry !== null && prevEntry.tagName === 'blank') prevEntry.remove();
				entry.remove();
			}

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({msg: 'Item split'});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);

};


exports.projectItemPUTmove = (req, res, next) => {

	// Required parameters: track, trackTarget, item, time
	if (!isset(req.body.track, req.body.trackTarget, req.body.item, req.body.time)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: track, trackTarget, item, time.',
		});
		return;
	}

	if (req.body.time !== '00:00:00,000' && !timeManager.isValidDuration(req.body.time)) {
		res.status(400);
		res.json({
			err: 'Wrong parameter.',
			msg: 'The time parameter must be in the format 00: 00: 00,000.',
		});
		return;
	}

	if (!(req.body.trackTarget.includes('videotrack') && req.body.track.includes('videotrack'))) {
		if (!(req.body.trackTarget.includes('audiotrack') && req.body.track.includes('audiotrack'))) {
			res.status(400);
			res.json({
				err: 'Incompatible tracks.',
				msg: 'You cannot move items between video and audio tracks.',
			});
			return;
		}
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const track = document.getElementById(req.body.track);
			const trackTarget = document.getElementById(req.body.trackTarget);
			if (track === null || trackTarget === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" or "${trackTarget}" is not in the project.`,
				});
				return;
			}

			let item = mltxmlManager.getItem(document, track, req.body.item);
			if (item === null) {
				release();
				res.status(404);
				res.json({
					err: 'Item not found.',
					msg: `${Req.body.item} is not on track "${req.body.track}".`,
				});
				return;
			}

			if (!mltxmlManager.isSimpleNode(item)) {
				item = item.parentElement; // Get multitrack of complex item
			}

			const itemDuration = mltxmlManager.getDuration(item, document).time;

			if (!mltxmlManager.isSimpleNode(item)) {
				item = item.parentElement; // Get tractor of complex item
				item = document.querySelector(`mlt>playlist>entry[producer="${item.id}"]`); // Get videotrack entry
			}

			// Add blank to old location
			const prevElement = item.previousElementSibling;
			const nextElement = item.nextElementSibling;
			let leftDuration = itemDuration;

			if (prevElement !== null && prevElement.tagName === 'blank') {
				leftDuration = timeManager.addDuration(leftDuration, prevElement.getAttribute('length'));
				prevElement.remove();
			}
			if (nextElement !== null && nextElement.tagName === 'blank') {
				leftDuration = timeManager.addDuration(leftDuration, nextElement.getAttribute('length'));
				nextElement.remove();
			}
			if (nextElement !== null) {
				const newBlank = document.createElement('blank');
				newBlank.setAttribute('length', leftDuration);
				track.insertBefore(newBlank, item);
			}
			item.remove();

			// Check free space
			if (mltxmlManager.getItemInRange(trackTarget, req.body.time, timeManager.addDuration(req.body.time, itemDuration), document).length > 0) {
				release();
				res.status(403);
				res.json({
					err: 'The destination already contains an item.',
					msg: 'The location you entered is not free, the item cannot be moved.',
				});
				return;
			}

			let targetElement = mltxmlManager.getItemAtTime(document, trackTarget, req.body.time);

			// Prepare target place
			if (targetElement.entries.length === 0) { // End of timeline
				if (targetElement.endTime < req.body.time) {
					const newBlank = document.createElement('blank');
					newBlank.setAttribute('length', timeManager.subDuration(req.body.time, targetElement.endTime));
					trackTarget.appendChild(newBlank);
				}
				trackTarget.appendChild(item);
			}
			else if (targetElement.entries.length === 1) { // Inside blank
				const afterLength = timeManager.subDuration(targetElement.endTime, timeManager.addDuration(req.body.time, itemDuration));
				const afterBlank = document.createElement('blank');
				afterBlank.setAttribute('length', afterLength);

				const beforeLength = timeManager.subDuration(targetElement.entries[0].getAttribute('length'), timeManager.addDuration(afterLength, itemDuration));
				const beforeBlank = document.createElement('blank');
				beforeBlank.setAttribute('length', beforeLength);

				if (beforeLength !== '00:00:00,000') trackTarget.insertBefore(beforeBlank, targetElement.entries[0]);
				trackTarget.insertBefore(item, targetElement.entries[0]);
				if (afterLength !== '00:00:00,000' && targetElement.entries[0].nextElementSibling !== null) trackTarget.insertBefore(afterBlank, targetElement.entries[0]);
				targetElement.entries[0].remove();
			}
			else { // Between two elements
				const blank =  (targetElement.entries[0].tagName === 'blank') ? targetElement.entries[0] : targetElement.entries[1];
				if (blank !== null) {
					blank.setAttribute('length', timeManager.subDuration(blank.getAttribute('length'), itemDuration));
					if (blank.getAttribute('lenght') === '00:00:00,000') blank.remove();
				}
				trackTarget.insertBefore(item, targetElement.entries[1]);
			}

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({msg: 'Item moved'});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);

};


exports.projectItemPUTsplit = (req, res, next) => {
	// Required parameters: track, item, time
	if (!isset(req.body.track, req.body.item, req.body.time)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: track, item, time.',
		});
		return;
	}

	if (!timeManager.isValidDuration(req.body.time)) {
		res.status(400);
		res.json({
			err: 'Wrong parameter.',
			msg: 'The time parameter must be positive, in the format 00: 00: 00,000.',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			let item = mltxmlManager.getItem(document, track, req.body.item);
			if (item === null) {
				release();
				res.status(404);
				res.json({
					err: 'Item not found.',
					msg: `Item ${req.body.item} is not on "${req.body.track}".`,
				});
				return;
			}

			const time = mltxmlManager.getDuration(item, document);

			if (req.body.time >= time.time) {
				release();
				res.status(400);
				res.json({
					err: 'Parameter out of range.',
					msg: `The time parameter must be between 00: 00: 00,000 and a ${time.time}`,
				});
				return;
			}

			let splitTime = req.body.time;
			if (time.in !== '00:00:00,000') splitTime = timeManager.addDuration(time.in, req.body.time);

			if (mltxmlManager.isSimpleNode(item)) { // It's simple element
				const itemCopy = item.cloneNode();
				track.insertBefore(itemCopy, item);
				itemCopy.setAttribute('out', splitTime);
				item.setAttribute('in', splitTime);
			}
			else {
				const tractor = item.parentElement.parentElement;
				if (tractor.getElementsByTagName('transition').length === 0) { // It's element with filter(s)
					const trackItem = document.querySelector(`mlt>playlist[id="${item.getAttribute('producer')}"]`).getElementsByTagName('entry')[0];
					const trackItemCopy = trackItem.cloneNode();
					trackItemCopy.setAttribute('out', splitTime);
					trackItem.setAttribute('in', splitTime);

					const playlistCopy = mltxmlManager.entryToPlaylist(trackItemCopy, document);

					const tractorCopy = mltxmlManager.createTractor(document);
					tractorCopy.innerHTML = `<multitrack><track producer="${playlistCopy.id}"/></multitrack>`;
					const filters = tractor.getElementsByTagName('filter');
					for (let filter of filters) {
						tractorCopy.innerHTML += filter.outerHTML;
					}

					const videotrackRefCopy = document.createElement('entry');
					videotrackRefCopy.setAttribute('producer', tractorCopy.id);
					const videotrackRef = document.querySelector(`mlt>playlist>entry[producer="${tractor.id}"]`);
					track.insertBefore(videotrackRefCopy, videotrackRef);
				}
				else { // It's element with transition(s)
					release();
					return; // TODO
				}
			}

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({msg: 'Item split'});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);
};


exports.projectTrackPOST = (req, res, next) => {
	// Required parameters: type
	if (!isset(req.body.type) || (req.body.type !== 'video' && req.body.type !== 'audio')) {
		res.status(400);
		res.json({
			err: 'Wrong parameter.',
			msg: 'The type parameter is missing or has a value other than "video" or "audio".',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);
			const mainTractor = document.querySelector('mlt>tractor[id="main"]');

			const tracks = document.querySelectorAll(`mlt>playlist[id^="${req.body.type}track"]`);
			const lastTrack = tracks.item(tracks.length - 1).id;
			const lastID = lastTrack.match(/^(.+)track(\d+)/);

			const newTractor = document.createElement('playlist');
			newTractor.id = lastID[1] + 'track' + (Number(lastID[2]) + 1);
			root.insertBefore(newTractor, mainTractor);

			const newTrack = document.createElement('track');
			newTrack.setAttribute('producer', newTractor.id);
			mainTractor.getElementsByTagName('multitrack').item(0).appendChild(newTrack);

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({
						msg: 'Stopa přidána',
						track: newTractor.id,
					});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);
};


exports.projectTrackDELETE = (req, res, next) => {

	// Required parameters: track, item, time
	if (!isset(req.body.track)) {
		res.status(400);
		res.json({
			err: 'Missing parameters.',
			msg: 'Missing required parameters: track.',
		});
		return;
	}

	mltxmlManager.loadMLT(req.params.projectID, 'w').then(
		([dom, , release]) => {
			const document = dom.window.document;
			const root = document.getElementsByTagName('mlt').item(0);
			let trackID = req.body.track;

			const track = document.getElementById(req.body.track);
			if (track === null) {
				release();
				res.status(404);
				res.json({
					err: 'Track not found.',
					msg: `The specified track "${req.body.track}" is not in the project.`,
				});
				return;
			}

			// Removing default track
			if (req.body.track === 'videotrack0' || req.body.track === 'audiotrack0') {
				const type  = (req.body.track.includes('video')) ? 'videotrack' : 'audiotrack';
				let nextTrack = null;
				let nextElement = track.nextElementSibling;
				while (nextElement !== null) {
					if (nextElement.id.includes(type)) {
						nextTrack = nextElement;
						break;
					}
					nextElement = nextElement.nextElementSibling;
				}

				if (nextTrack === null) {
					release();
					res.status(403);
					res.json({
						err: 'The track cannot be deleted.',
						msg: 'The default tracks "videotrack0" and "audiotrack0" cannot be deleted.',
					});
					return;
				}

				trackID = nextElement.id;
				nextElement.id = type + '0'; // Rename next element to videotrack0/audiotrack0
			}

			const trackRef = document.querySelector(`mlt>tractor>multitrack>track[producer="${trackID}"]`);
			trackRef.remove();
			track.remove();

			mltxmlManager.saveMLT(req.params.projectID, root.outerHTML, release).then(
				() => {
					res.json({
						msg: 'Track deleted',
					});
				},
				err => next(err)
			);
		},
		err => fileErr(err, res)
	);
};


/**
 * Handle error while opening project directory.
 *
 * @param err
 * @param res
 */
function fileErr(err, res) {
	if (err.code === 'ENOENT') {
		res.status(404).json({
			err: 'The project does not exist',
			msg: 'The specified project does not exist.',
		});
	}
	else {
		log.error(err.stack);
		res.status(500).json({
			err: 'Unable to open project',
			msg: 'An error occurred while loading the project.',
		});
	}
}


/**
 * Check if numbers are positive integers
 *
 * @param numbers
 * @return {boolean} Return TRUE only if all of the parameters fits
 */
function isNaturalNumber(...numbers) {
	for (let number of numbers) {
		if (typeof number !== 'number' || !Number.isInteger(number) || number < 0) return false;
	}
	return true;
}


/**
 * Determine if variables are declared
 *
 * @param variables Rest parameters
 * @return {boolean} Return TRUE only if all of the parameters are set
 */
function isset(...variables) {
	for (let variable of variables) {
		if (typeof variable === 'undefined') return false;
	}
	return true;
}
