'use strict';

const AWS = require('aws-sdk');
const mime = require('mime');

const codecommit = new AWS.CodeCommit();
const dynamodb = new AWS.DynamoDB();
const sqs = new AWS.SQS();
const sns = new AWS.SNS();
const s3 = new AWS.S3();

exports.handler = function(event, _, callback) {

	// is it a run event?
	if (!event.Records.some(rec => (rec.Sns && (rec.Sns.Message === 'run')))) {
		console.log('unrecognized message, skipping');
		return callback();
	}

	// read a message from the publisher actions queue
	sqs.receiveMessage({
		QueueUrl: process.env.PUBLISHER_ACTIONS_QUEUE_URL,
		MaxNumberOfMessages: 1
	}, (err, data) => {

		if (err) {
			console.error('error reading message from publisher actions queue:', err);
			return callback(err);
		}

		if (!data.Messages || (data.Messages.length === 0)) {
			console.log('no more publisher actions in the queue');
			return callback();
		}

		const message = data.Messages[0];
		const action = JSON.parse(message.Body);
		console.log('processing publisher action ' + message.MessageId + ':', action);

		// read current in progress commit id
		dynamodb.getItem({
			TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
			Key: { 'RepositoryName': { S: action.repositoryName } },
			ProjectionExpression: 'InProgressCommitId',
			ConsistentRead: true
		}, (err, data) => {

			if (err) {
				console.error('error reading publisher status from DynamoDB:', err);
				return callback(err);
			}

			// check if for currenttly in progress publish operation
			const inProgressCommitId = data.Item && data.Item.InProgressCommitId && data.Item.InProgressCommitId.S;
			if (inProgressCommitId !== action.commitId) {
				console.log('action is not for the commit currently in progress, skipping it');
				return callback();
			}

			// target bucket name and target key prefix
			const targetBucket = process.env.TARGET_BUCKET.replace(/\$\{repo\}/g, action.repositoryName);
			const targetPrefix = (
				process.env.TARGET_FOLDER && (process.env.TARGET_FOLDER.length > 0) ?
					process.env.TARGET_FOLDER.replace(/\$\{repo\}/g, action.repositoryName) + '/' : ''
			);

			// pre-resolve the action chain
			let chain = Promise.resolve();

			// perform the action
			if (action.action === 'DELETE') {
				chain = chain.then(() => new Promise((resolve, reject) => {
					console.log('deleting object at ' + targetBucket + ':' + targetPrefix + action.path);
					s3.deleteObject({
						Bucket: targetBucket,
						Key: targetPrefix + action.path
					}, err => {
						if (err) {
							if (err.code === 'InvalidAccessKeyId') {
								console.log('object already missing');
								return resolve();
							}
							console.error('error deleting object in S3:', err);
							return reject(err);
						}
						resolve();
					});
				}));
			} else { // action: ADD
				chain = chain.then(() => new Promise((resolve, reject) => {
					console.log('loading ' + action.path + ' from ' + action.repositoryName + ' repository');
					codecommit.getBlob({
						repositoryName: action.repositoryName,
						blobId: action.blobId
					}, (err, data) => {
						if (err) {
							console.error('error reading object from CodeCommit:', err);
							return reject(err);
						}
						resolve(data.content);
					});
				})).then(content => new Promise((resolve, reject) => {
					console.log('uploading ' + content.length + ' bytes to ' + targetBucket + ':' + targetPrefix + action.path);
					s3.putObject({
						Bucket: targetBucket,
						Key: targetPrefix + action.path,
						ContentType: mime.getType(action.path) || 'application/octet-stream',
						Body: content
					}, err => {
						if (err) {
							console.error('error uploading object to S3:', err);
							return reject(err);
						}
						resolve();
					});
				}));
			}

			// update the counter in the table
			chain.then(() => new Promise((resolve, reject) => {
				dynamodb.updateItem({
					TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
					Key: { 'RepositoryName': { S: action.repositoryName } },
					UpdateExpression: 'SET NumRemainingActions = NumRemainingActions - :one',
					ConditionExpression: 'InProgressCommitId = :InProgressCommitId',
					ExpressionAttributeValues: {
						':InProgressCommitId': { S: action.commitId },
						':one': { N: '1' }
					},
					ReturnValues: 'UPDATED_NEW'
				}, (err, data) => {
					if (err) {
						if (err.code === 'ConditionalCheckFailedException') {
							console.log('currently in progress commit changed');
							return resolve(false);
						} else {
							console.error('error updating publisher status in DynamoDB:', err);
							return reject(err);
						}
					}
					resolve(Number(data.Attributes.NumRemainingActions.N) <= 0);
				});

			// update last published commit if done
			})).then(done => done && new Promise((resolve, reject) => {
				dynamodb.updateItem({
					TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
					Key: { 'RepositoryName': { S: action.repositoryName } },
					UpdateExpression: 'SET PublishedCommitId = :PublishedCommitId',
					ExpressionAttributeValues: {
						':PublishedCommitId': { S: action.commitId }
					}
				}, err => {
					if (err) {
						console.error('error updating publisher status in DynamoDB:', err);
						return reject(err);
					}
					resolve();
				});

			// delete message from the queue
			})).then(() => new Promise((resolve, reject) => {
				sqs.deleteMessage({
					QueueUrl: process.env.PUBLISHER_ACTIONS_QUEUE_URL,
					ReceiptHandle: message.ReceiptHandle
				}, err => {
					if (err) {
						console.error('error deleting publisher action message from the queue:', err);
						return reject(err);
					}
					resolve();
				});

			// trigger next queue poll
			})).then(() => new Promise((resolve, reject) => {
				sns.publish({
					TopicArn: process.env.PUBLISHER_NOTIFICATIONS_TOPIC_ARN,
					Message: 'run'
				}, err => {
					if (err) {
						console.error('error sending notification to SNS topic:', err);
						return reject(err);
					}
					resolve();
				});
			})).then(() => {
				console.log('publisher action successfully performed');
				callback();

			// catch and log fatal error
			}).catch(err => {
				callback(err);
			});
		});
	});
};
