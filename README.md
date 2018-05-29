# Cody

_Cody_ is an [Amazon Web Services](https://aws.amazon.com/) solution that automatically publishes content from a git repository in [AWS CodeCommit](https://aws.amazon.com/codecommit/) to an [Amazon S3](https://aws.amazon.com/s3/) bucket. Whenever the content is updated in the repository, _Cody_ publishes the changes. It is especially useful for serving static websites from S3 (or [Amazon CloudFront](https://aws.amazon.com/cloudfront/) distribution backed by S3), while maintaining the website content source in a git repository. A single _Cody_ installation in a given AWS account can be used to maintain more than one website.

## How It Works

_Cody_ is deployed in AWS as an [AWS CloudFormation](https://aws.amazon.com/cloudformation/) stack and uses only serverless AWS components, so once deployed, no maintenance is required. Below is the solution diagram:

![Diagram](https://raw.githubusercontent.com/boylesoftware/cody/master/docs/img/diagram.png)

Pushing a new commit to the CodeCommit repository triggers Commit Handler Lambda function. This Lambda function attempts to find the previously published commit ID for the repository in the Publisher Status DynamoDB table. If it finds it, it performs the difference between the previously published commit and the new commit. If it does not find it, it gets the different between the new commit and an empty repository to get the full content. For each changed file the Commit Handler Lambda function creates a publishing acttion, which can be "delete file from target S3 bucket" or "upload file to target S3 bucket". Each generated publishing action is then pushed to the Publishing Actions Queue. When action for all changes have been pushed to the queue, the Commit Handler Lambda function triggers the Publisher Lambda function by sending a notification to its SNS topic.

The Publisher Lambda function reads publisher actions from the queue one by one for executes them. Once all actions have been applied and the target S3 bucket content is thus synchronized with the contents of the CodeCommit respository, the Publisher Lambda function updates the Publisher Status DynamoDB table with the new published commit ID so that next time the Commit Handler can calculate the correct difference for the new commit.

## Installation

Prerequisites:

1. create target S3 bucket
2. create CodeCommit repository, make initial commit and push to create master branch

Build:

1. clone git repo
2. npm install
3. gulp

Setup:

1. upload Lambda zips to S3 bucket
2. deploy CloudFormation stack
3. set target S3 bucket policy
4. associate email with DLQ topic
5. create trigger
6. perform a commit and push to publish the site
