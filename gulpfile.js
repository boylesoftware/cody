'use strict';

const { series, parallel, src, dest } = require('gulp');
const gulpLoadPlugins = require('gulp-load-plugins');

const plugins = gulpLoadPlugins();

function assembleLambda(pkg) {

  return src([
    `./lambda/${pkg}/**/*.js`,
    `./lambda/${pkg}/package*.json`,
    `!./lambda/${pkg}/node_modules/**`
  ]).pipe(
    dest(`./build/lambda/${pkg}`)
  ).pipe(
    plugins.install({
      production: true
    })
  );
}

function packageLambda(pkg) {

  return src(
    `./build/lambda/${pkg}/**/*`
  ).pipe(
    plugins.zip(`cody-${pkg}.zip`)
  ).pipe(
    dest('./build')
  );
}

function assembleCommitHandler() {
  return assembleLambda('commit-handler');
}

function packageCommitHandler() {
  return packageLambda('commit-handler');
}

function assemblePublisher() {
  return assembleLambda('publisher');
}

function packagePublisher() {
  return packageLambda('publisher');
}

exports.assembleCommitHandler = assembleCommitHandler;
exports.packageCommitHandler = series(assembleCommitHandler, packageCommitHandler);
exports.assemblePublisher = assemblePublisher;
exports.packagePublisher = series(assemblePublisher, packagePublisher);

exports.default = parallel(
  series(assembleCommitHandler, packageCommitHandler),
  series(assemblePublisher, packagePublisher)
);
