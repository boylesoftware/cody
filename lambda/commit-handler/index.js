'use strict';

const AWS = require('aws-sdk');

const codecommit = new AWS.CodeCommit();
const dynamodb = new AWS.DynamoDB();
const sqs = new AWS.SQS();
const sns = new AWS.SNS();

const IGNORED = new RegExp('\\.gitignore$');

exports.handler = function(event, _, callback) {

	// pre-resolve actions chain
	let chain = Promise.resolve();

	// process each event
	for (const rec of event.Records) {

		// get repository name and commit id
		const repositoryName = rec.eventSourceARN.split(':')[5];
		const commitId = rec.codecommit.references[0].commit;
		console.log('publishing repo ' + repositoryName + ' commit ' + commitId);

		// try to get last published commit
		chain = chain.then(() => new Promise((resolve, reject) => {
			dynamodb.getItem({
				TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
				Key: { 'RepositoryName': { S: repositoryName } },
				ProjectionExpression: 'PublishedCommitId',
				ConsistentRead: true
			}, (err, data) => {
				if (err) {
					console.error('error reading publisher status from DynamoDB:', err);
					return reject(err);
				}
				resolve(data.Item && data.Item.PublishedCommitId && data.Item.PublishedCommitId.S);
			});

		// get difference since last published commit (if any)
		})).then(publishedCommitId => new Promise((resolve, reject) => {
			if (publishedCommitId)
				console.log('found currently published commit: ' + publishedCommitId);
			else
				console.log('no currently published commit, performing full repository publish');
			codecommit.getDifferences({
				repositoryName: repositoryName,
				beforeCommitSpecifier: (publishedCommitId ? publishedCommitId : undefined),
				afterCommitSpecifier: commitId
			}, (err, data) => {
				if (err) {
					console.error('error performing CodeCommit diff:', err);
					return reject(err);
				}
				resolve((data.differences || []).filter(diff => !(
					(diff.beforeBlob && IGNORED.test(diff.beforeBlob.path)) ||
					(diff.afterBlob && IGNORED.test(diff.afterBlob.path))
				)));
			});

		// update status table and make current commit in progress
		})).then(differences => new Promise((resolve, reject) => {
			console.log('found ' + differences.length + ' differences');
			dynamodb.updateItem({
				TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
				Key: { 'RepositoryName': { S: repositoryName } },
				UpdateExpression: 'SET ' + [
					'InProgressCommitId = :InProgressCommitId',
					'NumRemainingActions = :NumRemainingActions'
				].join(', '),
				ExpressionAttributeValues: {
					':InProgressCommitId': { S: commitId },
					':NumRemainingActions': { N: String(differences.length) }
				}
			}, err => {
				if (err) {
					console.error('error updating publisher status in DynamoDB:', err);
					return reject(err);
				}
				resolve(differences);
			});

		// push differences onto the publishing queue
		})).then(differences => {
			console.log('queueing publisher actions');
			let queueChain = Promise.resolve();
			for (let diff of differences) {
				queueChain = queueChain.then(() => new Promise((resolve, reject) => {
					const action = {
						repositoryName: repositoryName,
						commitId: commitId
					};
					if (diff.changeType === 'D') {
						action.action = 'DELETE';
						action.path = diff.beforeBlob.path;
					} else {
						action.action = 'ADD';
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
			return queueChain;

		// notify the publisher
		}).then(() => new Promise((resolve, reject) => {
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

		// done
		})).then(() => {
			console.log('commit successfully handled');
			callback();

		// catch and log fatal error
		}).catch(err => {
			callback(err);
		});
	}
};
