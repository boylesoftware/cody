# Cody

_Cody_ is an [Amazon Web Services](https://aws.amazon.com/) solution that automatically publishes content from a git repository in [AWS CodeCommit](https://aws.amazon.com/codecommit/) to an [Amazon S3](https://aws.amazon.com/s3/) bucket. Whenever the content is updated in the repository, _Cody_ publishes the changes. It is especially useful for serving static websites from S3 (or [Amazon CloudFront](https://aws.amazon.com/cloudfront/) distribution backed by S3), while maintaining the website content source in a git repository. A single _Cody_ installation in an AWS account can be used to maintain more than one website.

## How It Works

_Cody_ is deployed in AWS as an [AWS CloudFormation](https://aws.amazon.com/cloudformation/) stack and uses only serverless AWS components, so once deployed, no maintenance is requried. Below is the solution diagram:

![Diagram](https://raw.githubusercontent.com/boylesoftware/cody/master/docs/img/diagram.svg)

TBD

## Installation

0. clone git repo
1. npm install
2. gulp
3. upload Lambda zips to S3 bucket
4. create target S3 bucket
5. deploy CloudFormation stack
6. set target S3 bucket policy
7. associate email with DLQ topic
8. create CodeCommit repository, make initial commit and push to create master branch
9. create trigger
10. perform a commit and push to publish the site
