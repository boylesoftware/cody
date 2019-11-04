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
    console.log(`processing publisher action ${message.MessageId}:`, action);
    const key = `${action.repositoryName}/${action.branchName}`;

    // read current in progress commit id
    dynamodb.getItem({
      TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
      Key: { 'RepositoryName': { S: key } },
      ProjectionExpression: [
        'NewCommitId',
        'NewIgnorePatterns',
        'NewConfig'
      ].join(', '),
      ConsistentRead: true
    }, (err, statusData) => {

      if (err) {
        console.error('error reading publisher status from DynamoDB:', err);
        return callback(err);
      }

      // check if for currently in progress publish operation
      const newCommitId = statusData.Item && statusData.Item.NewCommitId && statusData.Item.NewCommitId.S;
      if (newCommitId !== action.commitId) {
        console.log('action is not for the commit currently being published, skipping it');
        return callback();
      }

      // get site config
      const config = JSON.parse(statusData.Item.NewConfig.S);

      // get content prefix
      let contentPrefix = String(config.contentPrefix || 'content');
      if ((contentPrefix.length > 0) && !contentPrefix.endsWith('/'))
        contentPrefix = `${contentPrefix}/`;

      // target bucket name and target key prefix
      const targetBucket = process.env.TARGET_BUCKET.replace(
        /\$\{repo\}/g, action.repositoryName
      ).replace(
        /\$\{branch\}/g, action.branchName
      );
      let targetPrefix = (
        process.env.TARGET_FOLDER && (process.env.TARGET_FOLDER.length > 0) ?
          process.env.TARGET_FOLDER.replace(
            /\$\{repo\}/g, action.repositoryName
          ).replace(
            /\$\{branch\}/g, action.branchName
          ) : ''
      );
      if ((targetPrefix.length > 0) && !targetPrefix.endsWith('/'))
        targetPrefix = `${targetPrefix}/`;

      // pre-resolve the action chain
      let chain = Promise.resolve();

      // check if action is for a content file
      if (action.path.startsWith(contentPrefix)) {

        // get target path
        const path = action.path.substring(contentPrefix.length);

        // perform the action
        switch (action.action) {
        case 'DELETE':
          chain = chain.then(() => new Promise((resolve, reject) => {
            console.log(`deleting object at ${targetBucket}:${targetPrefix}${path}`);
            s3.deleteObject({
              Bucket: targetBucket,
              Key: `${targetPrefix}${path}`
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
          break;
        case 'PUT':
          chain = chain.then(() => new Promise((resolve, reject) => {
            console.log(`loading ${action.path} from ${action.repositoryName} repository`);
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
            console.log(`uploading ${content.length} bytes to ${targetBucket}:${targetPrefix}${path}`);
            s3.putObject({
              Bucket: targetBucket,
              Key: `${targetPrefix}${path}`,
              ContentType: mime.getType(path) || 'application/octet-stream',
              Body: content
            }, err => {
              if (err) {
                console.error('error uploading object to S3:', err);
                return reject(err);
              }
              resolve();
            });
          }));
          break;
        default:
          console.log('unknown action, skipping it');
        }

      } else {
        console.log('action is not for a content file, skipping it');
      }

      // update remaining actions counter in the publisher status table
      chain.then(() => new Promise((resolve, reject) => {
        dynamodb.updateItem({
          TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
          Key: { 'RepositoryName': { S: key } },
          UpdateExpression: 'SET RemainingActions = RemainingActions - :One',
          ConditionExpression: 'NewCommitId = :CommitId',
          ExpressionAttributeValues: {
            ':CommitId': { S: action.commitId },
            ':One': { N: '1' }
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
          resolve(Number(data.Attributes.RemainingActions.N) <= 0);
        });

      // update last published commit if done
      })).then(done => done && new Promise((resolve, reject) => {
        dynamodb.updateItem({
          TableName: process.env.PUBLISHER_STATUS_TABLE_NAME,
          Key: { 'RepositoryName': { S: key } },
          UpdateExpression: 'SET ' + [
            'PublishedCommitId = :CommitId',
            'PublishedIgnorePatterns = :IgnorePatterns',
            'PublishedConfig = :Config'
          ].join(', '),
          ExpressionAttributeValues: {
            ':CommitId': statusData.Item.NewCommitId,
            ':IgnorePatterns': statusData.Item.NewIgnorePatterns,
            ':Config': statusData.Item.NewConfig
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

      // success
      })).then(() => {
        console.log('publisher action successfully performed');
        callback();

      // catch and report fatal error
      }).catch(err => {
        callback(err);
      });
    });
  });
};
