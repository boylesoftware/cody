'use strict';

const AWS = require('aws-sdk');
const ini = require('ini');
const mm = require('micromatch');

const codecommit = new AWS.CodeCommit();
const dynamodb = new AWS.DynamoDB();
const sqs = new AWS.SQS();
const sns = new AWS.SNS();

exports.handler = function(event, _, callback) {

	// pre-resolve actions chain
	let chain = Promise.resolve();

	// process each event
	for (const rec of event.Records) {

		// get repository name and commit id
		const repositoryName = rec.eventSourceARN.split(':')[5];
		const commitId = rec.codecommit.references[0].commit;
		console.log(`publishing repo ${repositoryName} commit ${commitId}`);

		// try to get current publisher status for the repository
		chain = chain.then(() => new Promise((resolve, reject) => {
			dynamodb.getItem({
				TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
				Key: { 'RepositoryName': { S: repositoryName } },
				ProjectionExpression: [
					'PublishedCommitId',
					'PublishedIgnorePatterns',
					'PublishedConfig'
				].join(', '),
				ConsistentRead: true
			}, (err, data) => {
				if (err) {
					console.error('error reading publisher status from DynamoDB:', err);
					return reject(err);
				}
				const status = {
					ignorePatterns: [],
					config: {}
				};
				if (data.Item) {
					const item = data.Item;
					status.publishedCommitId = item.PublishedCommitId && item.PublishedCommitId.S;
					status.ignorePatterns = item.PublishedIgnorePatterns && item.PublishedIgnorePatterns.L.map(e => e.S);
					status.config = item.PublishedConfig && JSON.parse(item.PublishedConfig.S);
				}
				resolve(status);
			});

		// get difference since last published commit (if any)
		})).then(status => new Promise((resolve, reject) => {
			if (status.publishedCommitId)
				console.log(`found currently published commit: ${status.publishedCommitId}`);
			else
				console.log('no currently published commit, performing full repository publish');
			codecommit.getDifferences({
				repositoryName: repositoryName,
				beforeCommitSpecifier: (status.publishedCommitId ? status.publishedCommitId : undefined),
				afterCommitSpecifier: commitId
			}, (err, data) => {
				if (err) {
					console.error('error performing CodeCommit diff:', err);
					return reject(err);
				}
				status.differences = data.differences || [];
				for (let diff of status.differences) {
					if (diff.changeType === 'D') {
						if (diff.beforeBlob.path === '.codyignore')
							status.ignorePatterns = [];
						else if (diff.beforeBlob.path === '.codyrc')
							status.config = {};
					} else if (diff.afterBlob.path === '.codyignore') {
						status.newIgnorePatternsBlobId = diff.afterBlob.blobId;
					} else if (diff.afterBlob.path === '.codyrc') {
						status.newConfigBlobId = diff.afterBlob.blobId;
					}
				}
				resolve(status);
			});

		// load new ignore patterns
		})).then(status => (
			status.newIgnorePatternsBlobId ?
				new Promise((resolve, reject) => {
					console.log('loading new .codyignore');
					codecommit.getBlob({
						repositoryName: repositoryName,
						blobId: status.newIgnorePatternsBlobId
					}, (err, data) => {
						if (err) {
							console.error('error reading .codyignore from CodeCommit:', err);
							return reject(err);
						}
						status.ignorePatterns = data.content.toString('utf8').trim().split(/\s*\r?\n\s*/);
						resolve(status);
					});
				}) : status

		// load new site configuration
		)).then(status => (
			status.newConfigBlobId ?
				new Promise((resolve, reject) => {
					console.log('loading new .codyrc');
					codecommit.getBlob({
						repositoryName: repositoryName,
						blobId: status.newConfigBlobId
					}, (err, data) => {
						if (err) {
							console.error('error reading .codyrc from CodeCommit:', err);
							return reject(err);
						}
						try {
							status.config = ini.parse(data.content.toString('utf8'));
						} catch (iniErr) {
							console.error('error parsing new .codyrc:', err);
							return reject(iniErr);
						}
						resolve(status);
					});
				}) : status

		// filter the differences
		)).then(status => {
			const excludes = new Set(mm(
				status.differences
					.map(diff => ((diff.afterBlob && diff.afterBlob.path) || diff.beforeBlob.path)),
				status.ignorePatterns
			));
			status.differences = status.differences.filter(diff => !(
				(diff.afterBlob && excludes.has(diff.afterBlob.path)) ||
				(diff.beforeBlob && excludes.has(diff.beforeBlob.path))
			));
			return status;

		// update publisher status table
		}).then(status => new Promise((resolve, reject) => {
			const numDiffs = status.differences.length;
			console.log(`found ${numDiffs} differences`);
			const prefix = (numDiffs > 0 ? 'New' : 'Published');
			const updates = [
				`${prefix}CommitId = :NewCommitId`,
				`${prefix}IgnorePatterns = :NewIgnorePatterns`,
				`${prefix}Config = :NewConfig`,
				'RemainingActions = :NumDiffs'
			];
			const values = {
				':NewCommitId': { S: commitId },
				':NewIgnorePatterns': { L: status.ignorePatterns.map(e => ({ S: e })) },
				':NewConfig': { S: JSON.stringify(status.config) },
				':NumDiffs': { N: String(numDiffs) }
			};
			dynamodb.updateItem({
				TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
				Key: { 'RepositoryName': { S: repositoryName } },
				UpdateExpression: 'SET ' + updates.join(', '),
				ExpressionAttributeValues: values
			}, err => {
				if (err) {
					console.error('error updating publisher status in DynamoDB:', err);
					return reject(err);
				}
				resolve(status);
			});

		// convert differences into publisher actions and queue them up
		})).then(status => {
			if (status.differences.length === 0)
				return status;
			console.log('queueing publisher actions');
			let queueChain = Promise.resolve();
			for (let diff of status.differences) {
				queueChain = queueChain.then(() => new Promise((resolve, reject) => {
					const action = {
						repositoryName: repositoryName,
						commitId: commitId
					};
					if (diff.changeType === 'D') {
						action.action = 'DELETE';
						action.path = diff.beforeBlob.path;
					} else {
						action.action = 'PUT';
						action.path = diff.afterBlob.path;
						action.blobId = diff.afterBlob.blobId;
					}
					sqs.sendMessage({
						QueueUrl: process.env.PUBLISHER_ACTIONS_QUEUE_URL,
						MessageBody: JSON.stringify(action)
					}, err => {
						if (err) {
							console.error('error sending publisher action to the queue:', err);
							return reject(err);
						}
						resolve();
					});
				}));
			}
			return queueChain.then(() => status);

		// notify the publisher
		}).then(status => (
			status.differences.length > 0 ?
				new Promise((resolve, reject) => {
					console.log('triggering publisher');
					sns.publish({
						TopicArn: process.env.PUBLISHER_NOTIFICATIONS_TOPIC_ARN,
						Message: 'run'
					}, err => {
						if (err) {
							console.error('error sending SNS notification to the publisher:', err);
							return reject(err);
						}
						resolve();
					});
				}) : undefined

		// success
		)).then(() => {
			console.log('commit successfully handled');
		});
	}

	// finish the chain
	return chain.then(
		() => callback(),
		err => callback(err)
	);
};
