/*global $,hljs*/
/* jslint nomen:true */
require('../../vendor/jquery.poshytip.min');
require('../../vendor/jquery.qrcode.min');

let service;
const popup = require('../../lib/dialog');
const $qrcodeShare = $('#qrcodeShare');
const $qrcodeReward = $('#qrcodeReward');

service = {
    initEvent: function () {
        $('body').on('submit', '.j-form-comment', function () {
            const $that = $(this);
            $.ajax({
                type: 'post',
                url: $that.attr('action'),
                data: $that.serialize(),
                dataType: 'json',
                success: function (d) {
                    if (d.code === 0) {
                        if (d.data.commentFlag === 'verify') {
                            popup.alert({
                                content: '评论成功，正在审核中……',
                                callback: function () {
                                    location.href = d.data.url;
                                }
                            });
                        } else {
                            location.href = d.data.url;
                        }
                    } else {
                        $('.csrfToken').val(d.token);
                        popup.alert(d.message);
                    }
                },
                error: function () {
                    return false;
                }
            });
            return false;
        }).on('click', '.j-vote-up', function () {
            const that = this;
            $.ajax({
                type: 'post',
                url: '/post/comment/vote',
                data: {
                    commentId: $(this).attr('data-comment'),
                    type: 'up',
                    _csrf: $('.csrfToken').val()
                },
                dataType: 'json',
                success: function (d) {
                    $('.csrfToken').val(d.token);
                    if (d.code === 0) {
                        $(that).find('.j-vote-count').html(d.data.commentVote);
                    } else {
                        popup.alert(d.message);
                    }
                },
                error: function () {
                    return false;
                }
            });
            return false;
        }).on('mouseover', '#btnShare', function () {
            $qrcodeShare.show();
        }).on('mouseout', '#btnShare', function () {
            $qrcodeShare.hide();
        }).on('mouseover', '#btnReward', function () {
            $qrcodeReward.show();
        }).on('mouseout', '#btnReward', function () {
            $qrcodeReward.hide();
        }).on('click', '#postContent img', function () {
            const $that = $(this);
            const $cloneImg = $that.clone(false);
            popup.custom({
                title: ' ',
                content: $cloneImg,
                width: '100%',
                showHeader: true,
                showFooter: false,
                quickClose: false,
                beforeRemove: false,
                ok: false,
                cancel: true,
                cancelValue: '关闭',
                onclose: function () {
                    $cloneImg.remove();
                }
            });
        });
    }
};

$(function () {
    service.initEvent();
    hljs.initHighlightingOnLoad();
    $qrcodeShare.qrcode({
        width: 150,
        height: 150,
        foreground: '#5f5f5f',
        text: $qrcodeShare.attr('data-url')
    });
    $qrcodeReward.qrcode({
        width: 150,
        height: 150,
        foreground: '#5f5f5f',
        text: 'https://wx.tenpay.com/f2f?t=AQAAAHJba4G%2FaqEgOMVB%2FbNG3ac%3D'
    });
});
