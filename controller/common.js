/**
 * Created by fuyun on 2017/04/13.
 */

const models = require('../models/index');

module.exports = {
    getInitOptions: function (cb) {
        models.Option.findAll({
            attributes: ['blogId', 'optionName', 'optionValue', 'autoload'],
            where: {
                autoload: 1
            }
        }).then(function (data) {
            let tmpObj = {};
            data.forEach((item) => {
                tmpObj[item.optionName] = {
                    blogId: item.blogId,
                    optionValue: item.optionValue
                };
            });
            cb(null, tmpObj);
        });
    },
    archiveDates: function (cb) {
        // 模型定义之外（别名）的属性需要通过.get()方式访问
        models.Post.findAll({
            attributes: [
                'postDate',
                [models.sequelize.fn('date_format', models.sequelize.col('post_date'), '%Y/%m'), 'linkDate'],
                [models.sequelize.fn('date_format', models.sequelize.col('post_date'), '%Y年%m月'), 'displayDate'],
                ['count(1)', 'count']
            ],
            where: {
                postStatus: 'publish',
                postType: 'post'
            },
            group: [models.sequelize.fn('date_format', models.sequelize.col('postDate'), '%Y-%m')],
            order: [[models.sequelize.col('linkDate'), 'desc']]
        }).then(function (data) {
            cb(null, data);
        });
    },
    recentPosts: function (cb) {
        models.Post.findAll({
            attributes: ['postId', 'postTitle', 'postGuid'],
            where: {
                postStatus: 'publish',
                postType: 'post'
            },
            order: [
                ['postModified', 'desc'],
                ['postDate', 'desc']
            ],
            limit: 10,
            offset: 0
        }).then(function (data) {
            cb(null, data);
        });
    },
    randPosts: function (cb) {
        models.Post.findAll({
            attributes: ['postId', 'postTitle', 'postGuid'],
            where: {
                postStatus: 'publish',
                postType: 'post'
            },
            order: [
                [models.sequelize.fn('rand'), 'asc']
            ],
            limit: 10,
            offset: 0
        }).then(function (data) {
            cb(null, data);
        });
    },
    hotPosts: function (cb) {
        models.Post.findAll({
            attributes: ['postId', 'postTitle', 'postGuid'],
            where: {
                postStatus: 'publish',
                postType: 'post'
            },
            order: [
                ['postViewCount', 'desc']
            ],
            limit: 10,
            offset: 0
        }).then(function (data) {
            cb(null, data);
        });
    },
    getLinks: function (slug, visible, cb) {
        models.Link.findAll({
            attributes: ['linkDescription', 'linkUrl', 'linkTarget', 'linkName'],
            include: [{
                model: models.TermTaxonomy,
                attributes: ['created', 'modified'],
                where: {
                    slug: slug,
                    taxonomy: 'link'
                }
            }],
            where: {
                linkVisible: visible
            },
            order: [
                ['linkRating', 'desc']
            ]
        }).then(function (data) {
            cb(null, data);
        });
    },
    createCategoryTree: function (categoryData) {
        let catTree = {};
        let treeNodes = [];

        function iterateCategory (treeData, parentId, parentNode, level) {
            for (let arrIdx = 0; arrIdx < treeData.length; arrIdx += 1) {
                let curNode = treeData[arrIdx];
                if (!treeNodes.includes(curNode.taxonomyId)) {
                    if (curNode.parent === parentId) {
                        parentNode[curNode.taxonomyId] = {
                            name: curNode.name,
                            description: curNode.description,
                            slug: curNode.slug,
                            count: curNode.count,
                            taxonomyId: curNode.taxonomyId,
                            parentId: curNode.parent,
                            level: level,
                            children: {}
                        };
                        treeNodes.push(curNode.taxonomyId);
                        iterateCategory(treeData, curNode.taxonomyId, parentNode[curNode.taxonomyId].children, level + 1);
                    }
                }
            }
        }

        iterateCategory(categoryData, '', catTree, 1);
        return catTree;
    },
    getCategoryTree: function (cb) {
        const that = this;
        models.TermTaxonomy.findAll({
            attributes: ['name', 'description', 'slug', 'count', 'taxonomyId', 'parent'],
            where: {
                taxonomy: 'post'
            },
            order: [
                ['termOrder', 'asc']
            ]
        }).then(function (data) {
            if (data.length > 0) {
                cb(null, that.createCategoryTree(data));
            } else {
                cb('分类不存在');
            }
        });
    },
    mainNavs: function (cb) {
        models.TermTaxonomy.findAll({
            attributes: ['name', 'description', 'slug', 'count', 'taxonomyId'],
            where: {
                taxonomy: 'post',
                parent: ''
            },
            order: [
                ['termOrder', 'asc']
            ]
        }).then(function (data) {
            cb(null, data);
        });
    },
    getPrevPost: function (postId, cb) {
        models.Post.findOne({
            attributes: ['postId', 'postGuid', 'postTitle'],
            where: {
                postStatus: 'publish',
                postType: 'post',
                postCreated: {
                    $gt: models.sequelize.literal(`(select post_created from posts where post_id = '${postId}')`)
                }
            },
            order: [
                ['postCreated', 'asc']
            ]
        }).then(function (data) {
            cb(null, data);
        });
    },
    getNextPost: function (postId, cb) {
        models.Post.findOne({
            attributes: ['postId', 'postGuid', 'postTitle'],
            where: {
                postStatus: 'publish',
                postType: 'post',
                postCreated: {
                    $lt: models.sequelize.literal(`(select post_created from posts where post_id = '${postId}')`)
                }
            },
            order: [
                ['postCreated', 'desc']
            ]
        }).then(function (data) {
            cb(null, data);
        });
    },
    getCategoryPath: function (catCrumb, catId, cb) {
        models.TermTaxonomy.findById(catId, {
            attributes: ['taxonomyId', 'name', 'slug', 'description']
        }).then(function (category) {
            catCrumb.unshift({
                'title': category.name,
                'tooltip': category.description,
                'url': '/category/' + category.slug,
                'headerFlag': false
            });
            if (category.parent) {
                this.getCategoryPath(catCrumb, category.parent, cb);
            } else {
                cb(null, catCrumb);
            }
        });
    }
};